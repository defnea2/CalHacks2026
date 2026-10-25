// Phrase / turn state machine on top of per-frame speech probabilities (spec "Voice input").
// Pure: no browser APIs. AudioCapture feeds it Silero frames; tests feed synthetic sequences.
//
//   idle ──speech ≥ threshold & energy gate──▶ candidate ──speech ≥ min speech──▶ phrase
//    ▲                                            │ gap too long: misfire            │
//    │                                            ▼                                  │ VAD_PHRASE_MS silence: final chunk
//    └──── VAD_TURN_MS silence since last speech: turn_end ◀───────────────────────┘
//
// Smart Turn (SMART_TURN=1): every silence phrase end also emits `smart_turn_request` with the
// turn's audio (last ≤ 8 s, pauses included). The caller runs the model and hands the
// probability back via smartTurnResult(); P ≥ SMART_TURN_THRESHOLD ends the turn as soon as
// SMART_TURN_MIN_SILENCE_MS of silence has passed, otherwise VAD_TURN_MS stays the fallback.
// Speech resuming invalidates the pending request.
//
// While the tutor speaks the start threshold is BARGE_IN_THRESHOLD and the min speech
// BARGE_IN_MIN_MS; confirming such a start emits `barge_in` before the phrase opens.
//
// Soft onsets (children after a thinking pause; Chrome mic processing on): Silero often stays at
// 0.01-0.45 for the first ~0.6 s of a loud word, so the phrase starts late (or the turn ends
// first). Three rules handle that:
// - Re-entry: between phrases of an open turn (tutor not speaking) the start threshold is
//   VAD_REENTRY_THRESHOLD (+ noisy boost); the energy gate and min speech still apply.
// - Hold: in an open turn every speech-like frame (candidate frames, incl. ones that end as a
//   misfire) restarts the turn-end wait; capped at VAD_TURN_HOLD_MAX_MS beyond the normal wait,
//   counted from the end of speech, so noise bursts cannot keep a turn open forever.
// - Onset pre-roll: a non-barge-in phrase gets VAD_PREROLL_MS before the energy onset (frames
//   >= floor + NOISE_SNR_DB right before the start), at most VAD_PREROLL_MAX_MS.
import { NoiseMonitor, type NoiseConfig, type NoiseState } from './noise';
import { ChunkAccumulator, concatFloat, rmsDbfs } from './pcm';

export interface VadMachineConfig extends NoiseConfig {
  INPUT_SAMPLE_RATE: number;
  AUDIO_CHUNK_MS: number;
  VAD_THRESHOLD: number;
  VAD_MIN_SPEECH_MS: number;
  VAD_PREROLL_MS: number;
  VAD_PHRASE_MS: number;
  VAD_TURN_MS: number;
  VAD_MAX_PHRASE_MS: number;
  BARGE_IN_THRESHOLD: number;
  BARGE_IN_MIN_MS: number;
  NOISY_THRESHOLD_BOOST: number;
  NOISY_MIN_SPEECH_MS: number;
  VAD_CANDIDATE_GAP_MS: number;
  VAD_HYSTERESIS: number;
  VAD_REENTRY_THRESHOLD: number;
  VAD_TURN_HOLD_MAX_MS: number;
  VAD_PREROLL_MAX_MS: number;
  SMART_TURN: number;
  SMART_TURN_THRESHOLD: number;
  SMART_TURN_MIN_SILENCE_MS: number;
}

/** Smart Turn's input window: the last 8 s of the turn. */
export const SMART_TURN_WINDOW_MS = 8000;

export type TurnEndReason = 'silence' | 'smart_turn' | 'stop';
export type SmartTurnDecision = 'complete' | 'incomplete' | 'stale';

export type VadEvent =
  | { type: 'speech_start'; phraseId: number; bargeIn: boolean; prerollMs: number }
  | { type: 'chunk'; phraseId: number; seq: number; pcm: Float32Array; final: boolean }
  | { type: 'phrase_end'; phraseId: number; durationMs: number; reason: 'silence' | 'max_length' | 'stop' }
  | { type: 'turn_end'; noiseDb: number | null; reason: TurnEndReason; silenceMs: number }
  | { type: 'smart_turn_request'; requestId: number; pcm: Float32Array; silenceMs: number }
  | { type: 'smart_turn'; requestId: number; prob: number; decision: SmartTurnDecision; silenceMs: number; ended: boolean }
  | { type: 'barge_in'; speechMs: number }
  | { type: 'misfire'; speechMs: number }
  | { type: 'noise_state'; state: NoiseState; floorDb: number | null };

/** Upper bound for the first chunk (pre-roll + candidate): the module rejects chunks > 2 s. */
const MAX_FIRST_CHUNK_MS = 1900;

interface RingFrame {
  pcm: Float32Array;
  db: number;
}

interface Candidate {
  frames: RingFrame[];
  preroll: RingFrame[];
  speechMs: number;
  gapMs: number;
}

interface OpenPhrase {
  phraseId: number;
  seq: number;
  acc: ChunkAccumulator;
  durationMs: number;
  silenceMs: number;
}

export interface EffectiveParams {
  threshold: number;
  minSpeechMs: number;
  bargeIn: boolean;
}

export class VadMachine {
  readonly noise: NoiseMonitor;
  /** Set by the client while tutor audio plays (or the session is `speaking`). */
  tutorSpeaking = false;
  private nextPhraseId: number;
  private ring: RingFrame[] = [];
  private ringMs = 0;
  private candidate: Candidate | null = null;
  private phrase: OpenPhrase | null = null;
  private turnOpen = false;
  /** Turn-end wait: silence since the last speech-like frame (reset by activity). */
  private silenceMs = 0;
  /** Time since the end of the last phrase's speech (not reset by activity; caps the hold). */
  private gapMs = 0;
  private lastNoiseState: NoiseState | null = null;
  /** Audio of the open turn (pre-roll, phrases and pauses), trimmed to SMART_TURN_WINDOW_MS. */
  private turnAudio: Float32Array[] = [];
  private turnAudioSamples = 0;
  private smartRequestSeq = 0;
  private smartPending = 0;
  private smartComplete = false;

  constructor(
    private readonly cfg: VadMachineConfig,
    opts: { firstPhraseId?: number } = {}
  ) {
    this.noise = new NoiseMonitor(cfg);
    this.nextPhraseId = Math.max(1, opts.firstPhraseId ?? 1);
  }

  /** Phrase ids must be unique within the session: call with (max existing id + 1) on resume. */
  setNextPhraseId(id: number): void {
    if (id > this.nextPhraseId) this.nextPhraseId = id;
  }

  get inPhrase(): boolean {
    return this.phrase !== null;
  }
  get inCandidate(): boolean {
    return this.candidate !== null;
  }
  get isTurnOpen(): boolean {
    return this.turnOpen;
  }
  get currentPhraseId(): number | null {
    return this.phrase?.phraseId ?? null;
  }

  /** Thresholds in effect for starting speech right now. */
  effective(): EffectiveParams {
    const noisy = this.noise.state === 'noisy';
    const boost = noisy ? this.cfg.NOISY_THRESHOLD_BOOST : 0;
    const threshold = Math.min(0.99, this.cfg.VAD_THRESHOLD + boost);
    const minSpeechMs = noisy ? Math.max(this.cfg.VAD_MIN_SPEECH_MS, this.cfg.NOISY_MIN_SPEECH_MS) : this.cfg.VAD_MIN_SPEECH_MS;
    if (this.tutorSpeaking && !this.phrase) {
      return {
        threshold: Math.min(0.99, Math.max(threshold, this.cfg.BARGE_IN_THRESHOLD + boost)),
        minSpeechMs: Math.max(minSpeechMs, this.cfg.BARGE_IN_MIN_MS),
        bargeIn: true,
      };
    }
    if (this.turnOpen && !this.phrase) {
      // between phrases of an open turn: soft re-entry (see header)
      return { threshold: Math.min(threshold, this.cfg.VAD_REENTRY_THRESHOLD + boost), minSpeechMs, bargeIn: false };
    }
    return { threshold, minSpeechMs, bargeIn: false };
  }

  /** Process one frame (16 kHz mono float). `levelDb` defaults to the frame's RMS dBFS. */
  process(prob: number, frame: Float32Array, levelDb = rmsDbfs(frame)): VadEvent[] {
    const events: VadEvent[] = [];
    const frameMs = (frame.length * 1000) / this.cfg.INPUT_SAMPLE_RATE;

    this.noise.update(levelDb, prob, frameMs);
    const ns = this.noise.state;
    if (ns !== this.lastNoiseState) {
      this.lastNoiseState = ns;
      events.push({ type: 'noise_state', state: ns, floorDb: this.noise.floorDb });
    }

    if (this.turnOpen) this.pushTurnAudio([frame]);

    if (this.phrase) {
      this.continuePhrase(prob, frame, frameMs, events);
      return events;
    }

    const eff = this.effective();
    const speechy = prob >= eff.threshold && this.noise.passesGate(levelDb);
    if (this.turnOpen) {
      this.gapMs += frameMs;
      // hold: speech-like sound means the child is not done (capped in turnWaitOver)
      this.silenceMs = speechy ? 0 : this.silenceMs + frameMs;
    }
    const rf: RingFrame = { pcm: frame, db: levelDb };

    if (!this.candidate) {
      if (speechy) {
        this.candidate = { frames: [rf], preroll: this.ring, speechMs: frameMs, gapMs: 0 };
        this.ring = [];
        this.ringMs = 0;
      } else {
        this.pushRing(rf);
      }
    } else {
      const c = this.candidate;
      c.frames.push(rf);
      // Hysteresis: between threshold - VAD_HYSTERESIS and threshold a frame neither adds speech
      // nor counts as a gap (Silero-style positive/negative thresholds).
      if (speechy) {
        c.speechMs += frameMs;
        c.gapMs = 0;
      } else if (prob < eff.threshold - this.cfg.VAD_HYSTERESIS) {
        c.gapMs += frameMs;
      }
      if (c.gapMs > this.cfg.VAD_CANDIDATE_GAP_MS) {
        events.push({ type: 'misfire', speechMs: c.speechMs });
        this.candidate = null;
        this.ring = [];
        this.ringMs = 0;
        for (const f of [...c.preroll, ...c.frames]) this.pushRing(f);
      }
    }

    if (this.candidate && this.candidate.speechMs >= eff.minSpeechMs) {
      this.openPhrase(this.candidate, eff.bargeIn, events);
      this.candidate = null;
      return events;
    }

    if (this.turnOpen) {
      if (this.smartComplete && this.turnWaitOver(this.cfg.SMART_TURN_MIN_SILENCE_MS)) this.endTurn('smart_turn', events);
      else if (this.turnWaitOver(this.cfg.VAD_TURN_MS)) this.endTurn('silence', events);
    }
    return events;
  }

  /** Turn-end wait of `waitMs` over: silence since the last activity (no candidate pending),
   *  or the hold cap (waitMs + VAD_TURN_HOLD_MAX_MS since the end of speech). */
  private turnWaitOver(waitMs: number): boolean {
    if (this.gapMs >= waitMs + Math.max(0, this.cfg.VAD_TURN_HOLD_MAX_MS)) return true;
    return !this.candidate && this.silenceMs >= waitMs;
  }

  /** Smart Turn verdict for a `smart_turn_request`. Returns the resulting events (maybe turn_end). */
  smartTurnResult(requestId: number, prob: number): VadEvent[] {
    const events: VadEvent[] = [];
    const live = requestId === this.smartPending && this.turnOpen && !this.phrase;
    if (!live) {
      events.push({ type: 'smart_turn', requestId, prob, decision: 'stale', silenceMs: this.gapMs, ended: false });
      return events;
    }
    this.smartPending = 0;
    this.smartComplete = prob >= this.cfg.SMART_TURN_THRESHOLD;
    const silenceMs = this.gapMs;
    const endNow = this.smartComplete && this.turnWaitOver(this.cfg.SMART_TURN_MIN_SILENCE_MS);
    events.push({ type: 'smart_turn', requestId, prob, decision: this.smartComplete ? 'complete' : 'incomplete', silenceMs, ended: endNow });
    if (endNow) this.endTurn('smart_turn', events);
    return events;
  }

  private endTurn(reason: TurnEndReason, events: VadEvent[]): void {
    events.push({ type: 'turn_end', noiseDb: this.noise.floorDb, reason, silenceMs: this.gapMs });
    this.turnOpen = false;
    this.silenceMs = 0;
    this.gapMs = 0;
    this.resetSmartTurn();
  }

  private resetSmartTurn(): void {
    this.smartPending = 0;
    this.smartComplete = false;
  }

  private pushTurnAudio(frames: Float32Array[]): void {
    if (!this.cfg.SMART_TURN) return;
    const max = (SMART_TURN_WINDOW_MS * this.cfg.INPUT_SAMPLE_RATE) / 1000;
    for (const f of frames) {
      this.turnAudio.push(f);
      this.turnAudioSamples += f.length;
    }
    while (this.turnAudio.length > 1 && this.turnAudioSamples - this.turnAudio[0]!.length >= max) {
      this.turnAudioSamples -= this.turnAudio.shift()!.length;
    }
  }

  /** Close everything (stop talking / leave): final chunk for an open phrase, then turn_end. */
  stop(): VadEvent[] {
    const events: VadEvent[] = [];
    if (this.phrase) this.closePhrase('stop', events);
    this.candidate = null;
    if (this.turnOpen) this.endTurn('stop', events);
    this.silenceMs = 0;
    this.gapMs = 0;
    this.resetSmartTurn();
    return events;
  }

  private ms(samples: number): number {
    return (samples * 1000) / this.cfg.INPUT_SAMPLE_RATE;
  }

  /** The ring keeps max(VAD_PREROLL_MS, VAD_PREROLL_MAX_MS); selectPreroll picks the tail. */
  private pushRing(f: RingFrame): void {
    this.ring.push(f);
    this.ringMs += this.ms(f.pcm.length);
    const keep = Math.max(this.cfg.VAD_PREROLL_MS, this.cfg.VAD_PREROLL_MAX_MS);
    while (this.ring.length > 1) {
      const firstMs = this.ms(this.ring[0]!.pcm.length);
      if (this.ringMs - firstMs < keep) break;
      this.ring.shift();
      this.ringMs -= firstMs;
    }
  }

  /** Pre-roll for a phrase start: VAD_PREROLL_MS, or (not for barge-in) VAD_PREROLL_MS before
   *  the energy onset, capped by VAD_PREROLL_MAX_MS and the first-chunk limit. */
  private selectPreroll(ring: RingFrame[], bargeIn: boolean, candMs: number): RingFrame[] {
    let wantMs = this.cfg.VAD_PREROLL_MS;
    const floor = this.noise.floorDb;
    if (!bargeIn && floor !== null && this.cfg.VAD_PREROLL_MAX_MS > wantMs) {
      const gate = floor + this.cfg.NOISE_SNR_DB;
      let onsetMs = 0;
      let backMs = 0;
      let quietMs = 0;
      for (let i = ring.length - 1; i >= 0; i--) {
        const fMs = this.ms(ring[i]!.pcm.length);
        backMs += fMs;
        if (ring[i]!.db >= gate) {
          onsetMs = backMs;
          quietMs = 0;
        } else if ((quietMs += fMs) > this.cfg.VAD_CANDIDATE_GAP_MS) break;
      }
      wantMs = Math.min(this.cfg.VAD_PREROLL_MAX_MS, Math.max(wantMs, onsetMs + this.cfg.VAD_PREROLL_MS));
    }
    wantMs = Math.min(wantMs, Math.max(0, MAX_FIRST_CHUNK_MS - candMs));
    // whole frames from the end until >= wantMs (VAD_PREROLL_MS 300 -> 320 ms)
    let i = ring.length;
    let got = 0;
    while (i > 0 && got < wantMs) got += this.ms(ring[--i]!.pcm.length);
    return ring.slice(i);
  }

  private chunkSamples(): number {
    return Math.round((this.cfg.AUDIO_CHUNK_MS * this.cfg.INPUT_SAMPLE_RATE) / 1000);
  }

  private openPhrase(c: Candidate, bargeIn: boolean, events: VadEvent[]): void {
    if (bargeIn) events.push({ type: 'barge_in', speechMs: c.speechMs });
    const phraseId = this.nextPhraseId++;
    const candMs = c.frames.reduce((n, f) => n + this.ms(f.pcm.length), 0);
    const preroll = this.selectPreroll(c.preroll, bargeIn, candMs).map(f => f.pcm);
    const prerollMs = this.ms(preroll.reduce((n, f) => n + f.length, 0));
    events.push({ type: 'speech_start', phraseId, bargeIn, prerollMs });
    const frames = c.frames.map(f => f.pcm);
    const first = concatFloat([...preroll, ...frames]);
    events.push({ type: 'chunk', phraseId, seq: 0, pcm: first, final: false });
    this.phrase = { phraseId, seq: 1, acc: new ChunkAccumulator(this.chunkSamples()), durationMs: candMs, silenceMs: c.gapMs };
    if (!this.turnOpen) {
      // new turn: its audio starts with the pre-roll (in an open turn every frame is already in)
      this.turnAudio = [];
      this.turnAudioSamples = 0;
      this.pushTurnAudio([...preroll, ...frames]);
    }
    this.turnOpen = true;
    this.silenceMs = 0;
    this.gapMs = 0;
    this.resetSmartTurn(); // speech resumed: any pending verdict is about older audio
  }

  private continuePhrase(prob: number, frame: Float32Array, frameMs: number, events: VadEvent[]): void {
    const p = this.phrase!;
    const base = this.effective(); // phrase open -> never the barge-in params
    const speechy = prob >= Math.max(0.05, base.threshold - this.cfg.VAD_HYSTERESIS);
    p.durationMs += frameMs;
    p.silenceMs = speechy ? 0 : p.silenceMs + frameMs;

    if (p.silenceMs >= this.cfg.VAD_PHRASE_MS) {
      p.acc.push(frame);
      const silence = p.silenceMs;
      this.closePhrase('silence', events);
      this.silenceMs = silence; // silence already elapsed counts toward the turn end
      this.gapMs = silence;
      if (this.cfg.SMART_TURN) {
        this.smartPending = ++this.smartRequestSeq;
        this.smartComplete = false;
        events.push({ type: 'smart_turn_request', requestId: this.smartPending, pcm: concatFloat(this.turnAudio), silenceMs: silence });
      }
      return;
    }
    if (p.durationMs >= this.cfg.VAD_MAX_PHRASE_MS) {
      p.acc.push(frame);
      this.closePhrase('max_length', events);
      // Speech goes on: a new phrase in the same turn, without pre-roll (the audio is contiguous).
      const phraseId = this.nextPhraseId++;
      events.push({ type: 'speech_start', phraseId, bargeIn: false, prerollMs: 0 });
      this.phrase = { phraseId, seq: 0, acc: new ChunkAccumulator(this.chunkSamples()), durationMs: 0, silenceMs: 0 };
      this.turnOpen = true;
      return;
    }
    const chunk = p.acc.push(frame);
    if (chunk) events.push({ type: 'chunk', phraseId: p.phraseId, seq: p.seq++, pcm: chunk, final: false });
  }

  private closePhrase(reason: 'silence' | 'max_length' | 'stop', events: VadEvent[]): void {
    const p = this.phrase!;
    events.push({ type: 'chunk', phraseId: p.phraseId, seq: p.seq++, pcm: p.acc.take(), final: true });
    events.push({ type: 'phrase_end', phraseId: p.phraseId, durationMs: p.durationMs, reason });
    this.phrase = null;
    this.ring = [];
    this.ringMs = 0;
  }
}
