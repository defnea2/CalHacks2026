// AudioCapture + Vad (spec "Pipeline components"): microphone -> Silero VAD (vad-web, ONNX
// Runtime Web, 16 kHz) -> VadMachine (our phrase/turn logic) -> VadEvents.
// The library is used only for frames and speech probabilities (onFrameProcessed); its own
// segmenting is disabled, so VAD_PHRASE_MS / VAD_TURN_MS / pre-roll / min speech / max phrase
// are all ours. Model, worklet and ORT wasm are served from /vad/ (copied at dev/build time).
// Smart Turn (SMART_TURN=1): VadMachine asks at each phrase end; the model runs in a worker
// (SmartTurn.ts) and its verdict goes back into the machine. Until the model is loaded, or if
// it fails, requests are dropped and the VAD_TURN_MS silence fallback ends the turn.
import { MicVAD } from '@ricky0123/vad-web';
import type { AppSettings } from '../config';
import { VadMachine, type VadEvent } from './vadMachine';
import { rmsDbfs } from './pcm';
import { eventLog } from '../lib/debug';
import { SmartTurnDetector } from './SmartTurn';
import { clampInputGain, micConstraints } from './audioPrefs';

export interface CaptureOptions {
  ctx: AudioContext;
  settings: AppSettings;
  firstPhraseId: number;
  onEvent: (e: VadEvent) => void;
  /** Called with the latest frame level and probability (UI meter), throttled by the caller. */
  onFrame?: (levelDb: number, prob: number) => void;
  /** audioinput deviceId ('' = default). */
  micId?: string;
  /** Input gain before the VAD / encoder (0.5..4). */
  inputGain?: number;
  /** The microphone track ended (device unplugged). */
  onTrackEnded?: () => void;
}

// Absolute URL: with the relative build base ('./') ONNX Runtime would otherwise resolve its wasm
// glue against its own chunk (assets/), not the page.
export const VAD_ASSET_PATH = new URL(`${import.meta.env.BASE_URL ?? '/'}vad/`, globalThis.location?.href ?? 'http://localhost/').href;

export class AudioCapture {
  readonly machine: VadMachine;
  private vad: MicVAD | null = null;
  /** Raw microphone stream; the VAD reads `dest.stream` (mic → GainNode → destination). */
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private micId: string;
  private stopped = false;
  private smartTurn: SmartTurnDetector | null = null;
  private smartTurnReady = false;

  constructor(private readonly opts: CaptureOptions) {
    const { voice, client } = opts.settings;
    this.machine = new VadMachine({ ...voice, ...client }, { firstPhraseId: opts.firstPhraseId });
    this.micId = opts.micId ?? '';
  }

  private async openMic(micId: string): Promise<MediaStream> {
    const { client } = this.opts.settings;
    const base: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: client.MIC_AEC !== 0,
      noiseSuppression: client.MIC_NS !== 0,
      autoGainControl: client.MIC_AGC !== 0,
    };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(base, micId) });
    const track = stream.getAudioTracks()[0];
    eventLog.log('capture.mic', { label: track?.label ?? '', deviceId: micId, settings: track?.getSettings?.() ?? {} });
    track?.addEventListener('ended', () => {
      if (this.stopped || this.stream !== stream) return;
      eventLog.log('capture.mic_ended', { deviceId: micId });
      this.opts.onTrackEnded?.();
    });
    return stream;
  }

  /** Hot-swap the microphone: the VAD keeps running, only the source in front of the gain changes. */
  async switchMic(micId: string): Promise<void> {
    if (this.stopped || !this.gain) {
      this.micId = micId;
      return;
    }
    const next = await this.openMic(micId);
    if (this.stopped) {
      next.getTracks().forEach(t => t.stop());
      return;
    }
    const old = this.stream;
    this.source?.disconnect();
    this.stream = next;
    this.micId = micId;
    this.source = this.opts.ctx.createMediaStreamSource(next);
    this.source.connect(this.gain);
    old?.getTracks().forEach(t => t.stop());
    eventLog.log('capture.mic_switched', { deviceId: micId });
  }

  setInputGain(v: number): void {
    if (this.gain) this.gain.gain.value = clampInputGain(v);
  }

  get deviceId(): string {
    return this.micId;
  }

  async start(): Promise<void> {
    const { ctx, settings } = this.opts;
    eventLog.log('capture.starting', { assets: VAD_ASSET_PATH, model: settings.client.VAD_MODEL });
    this.vad = await MicVAD.new({
      model: settings.client.VAD_MODEL,
      audioContext: ctx,
      baseAssetPath: VAD_ASSET_PATH,
      onnxWASMBasePath: VAD_ASSET_PATH,
      startOnLoad: false,
      // The library's own segmenting is never used; keep its thresholds out of the way.
      positiveSpeechThreshold: 0.999,
      negativeSpeechThreshold: 0.998,
      redemptionMs: 1000, // keeps the library's internal segment buffer bounded
      minSpeechMs: 0,
      preSpeechPadMs: 0,
      ortConfig: ort => {
        ort.env.logLevel = 'error';
        ort.env.wasm.numThreads = 1;
      },
      getStream: async () => {
        this.stream = await this.openMic(this.micId);
        this.source = ctx.createMediaStreamSource(this.stream);
        this.gain = ctx.createGain();
        this.gain.gain.value = clampInputGain(this.opts.inputGain ?? 1);
        this.dest = ctx.createMediaStreamDestination();
        this.source.connect(this.gain).connect(this.dest);
        return this.dest.stream;
      },
      onFrameProcessed: (probs, frame) => this.onFrame(probs.isSpeech, frame),
    });
    await this.vad.start();
    if (this.stopped) {
      // stop() ran while the microphone was opening: release what start() created after it
      await this.vad.destroy().catch(() => {});
      this.releaseGraph();
      return;
    }
    eventLog.log('capture.started', {});
    if (settings.voice.SMART_TURN) this.startSmartTurn();
  }

  private startSmartTurn(): void {
    const t0 = performance.now();
    try {
      this.smartTurn = new SmartTurnDetector(VAD_ASSET_PATH);
    } catch (err) {
      eventLog.log('smart_turn.error', { error: String(err) });
      return;
    }
    this.smartTurn.ready.then(
      r => {
        this.smartTurnReady = true;
        eventLog.log('smart_turn.ready', { ...r, totalMs: Math.round(performance.now() - t0) });
      },
      err => eventLog.log('smart_turn.error', { error: String(err) })
    );
  }

  private onSmartTurnRequest(e: Extract<VadEvent, { type: 'smart_turn_request' }>): void {
    const audioMs = Math.round(e.pcm.length / 16);
    if (!this.smartTurn || !this.smartTurnReady) {
      eventLog.log('vad.smart_turn', { requestId: e.requestId, prob: null, ms: 0, decision: 'unavailable', audioMs });
      return;
    }
    const t0 = performance.now();
    void this.smartTurn.predict(e.requestId, e.pcm).then(v => {
      if (this.stopped) return;
      const ms = Math.round(performance.now() - t0);
      if (!v) {
        eventLog.log('vad.smart_turn', { requestId: e.requestId, prob: null, ms, decision: 'skipped', audioMs });
        return;
      }
      for (const ev of this.machine.smartTurnResult(e.requestId, v.prob)) {
        if (ev.type === 'smart_turn') {
          eventLog.log('vad.smart_turn', {
            requestId: e.requestId,
            prob: Math.round(v.prob * 1000) / 1000,
            ms,
            decision: ev.decision,
            ended: ev.ended,
            silenceMs: Math.round(ev.silenceMs),
            featMs: Math.round(v.featMs),
            inferMs: Math.round(v.inferMs),
            audioMs,
          });
        }
        this.opts.onEvent(ev);
      }
    });
  }

  private emit(events: VadEvent[]): void {
    for (const e of events) {
      if (e.type === 'smart_turn_request') this.onSmartTurnRequest(e);
      else this.opts.onEvent(e);
    }
  }

  private stats = { n: 0, levelSum: 0, maxLevel: -100, maxProb: 0, since: 0 };

  private onFrame(prob: number, frame: Float32Array): void {
    if (this.stopped) return;
    const level = rmsDbfs(frame);
    // once a second: frame statistics (helps debug fake microphones in the E2E harness)
    const st = this.stats;
    const now = performance.now();
    if (st.since === 0) st.since = now;
    st.n++;
    st.levelSum += level;
    st.maxLevel = Math.max(st.maxLevel, level);
    st.maxProb = Math.max(st.maxProb, prob);
    if (now - st.since >= 1000) {
      eventLog.log('vad.frame_stats', {
        frames: st.n,
        meanDb: Math.round(st.levelSum / st.n),
        maxDb: Math.round(st.maxLevel),
        maxProb: Math.round(st.maxProb * 100) / 100,
        floorDb: this.machine.noise.floorDb === null ? null : Math.round(this.machine.noise.floorDb),
        tutorSpeaking: this.machine.tutorSpeaking,
      });
      this.stats = { n: 0, levelSum: 0, maxLevel: -100, maxProb: 0, since: now };
    }
    this.opts.onFrame?.(level, prob);
    const events = this.machine.process(prob, frame, level);
    if (this.opts.settings.client.VAD_FRAME_DUMP) this.dumpFrame(prob, level, events);
    this.emit(events);
  }

  // Debug (?vad_frame_dump=1): per-frame data in batches of ~1 s, so the event log stays small.
  private dump: { t0: number; p: number[]; db: number[]; s: string[] } | null = null;

  private dumpFrame(prob: number, level: number, events: VadEvent[]): void {
    const m = this.machine;
    // i idle, c candidate, p phrase; upper case while the turn is open; event markers appended
    let st = m.inPhrase ? 'p' : m.inCandidate ? 'c' : 'i';
    if (m.isTurnOpen) st = st.toUpperCase();
    for (const e of events) {
      if (e.type === 'speech_start') st += '+';
      else if (e.type === 'phrase_end') st += '/';
      else if (e.type === 'turn_end') st += '|';
      else if (e.type === 'misfire') st += 'x';
    }
    if (m.tutorSpeaking) st += 't';
    this.dump ??= { t0: performance.now(), p: [], db: [], s: [] };
    this.dump.p.push(Math.round(prob * 100) / 100);
    this.dump.db.push(Math.round(level));
    this.dump.s.push(st);
    if (this.dump.p.length >= 32) {
      const { t0, p, db, s } = this.dump;
      eventLog.log('vad.frame_dump', { t0: Math.round(t0), floorDb: m.noise.floorDb === null ? null : Math.round(m.noise.floorDb), p, db, s });
      this.dump = null;
    }
  }

  set tutorSpeaking(v: boolean) {
    this.machine.tutorSpeaking = v;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.emit(this.machine.stop());
    this.stopped = true;
    this.smartTurn?.destroy();
    try {
      await this.vad?.destroy();
    } catch (err) {
      eventLog.log('capture.error', { error: String(err) });
    }
    this.releaseGraph();
    eventLog.log('capture.stopped', {});
  }

  private releaseGraph(): void {
    this.source?.disconnect();
    this.gain?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    this.dest?.stream.getTracks().forEach(t => t.stop());
  }
}
