// PlaybackQueue (spec "Pipeline components"): 24 kHz PCM16 sentence blocks from `audio_out`
// -> speaker. Strict sentence order, trimmed silence, short fades, own pause after each
// sentence, gapless scheduling, flush on interrupt.
import type { PlaybackSettings, ClientSettings } from '../config';
import { applyFades, SentenceOrderer, trimRange, type SentenceBlock } from './playbackLogic';
import { int16ToFloat, pcm16ToInt16 } from './pcm';
import { eventLog } from '../lib/debug';
import type { SentenceTiming } from '../board/reveal';

export interface AudioBlockIn {
  utteranceId: bigint;
  idx: number;
  pcm: Uint8Array;
  sampleRate: number;
  /** TTS word timestamps (ms from the start of `pcm`), if any. */
  wordStartsMs?: number[];
  wordEndsMs?: number[];
}

export interface PlaybackCallbacks {
  /** A sentence starts playing now (drives markPlayed, captions and board reveal). `timing`
   *  places its words on the performance.now() clock (inline board markers). */
  onSentenceStart?: (utteranceId: bigint, idx: number, timing: SentenceTiming) => void;
  /** Playing state changed (true while audio is scheduled ahead). */
  onPlayingChange?: (playing: boolean) => void;
}

interface Scheduled {
  utteranceId: bigint;
  idx: number;
  source: AudioBufferSourceNode;
  startAt: number;
  endAt: number;
  /** Word timing of this sentence (startMs is set when it really starts). */
  timing: Omit<SentenceTiming, 'startMs'>;
  timer: ReturnType<typeof setTimeout>;
  started: boolean;
  cancelled: boolean;
}

export class PlaybackQueue {
  private orderer: SentenceOrderer<AudioBlockIn>;
  private scheduled: Scheduled[] = [];
  /** Start triggers of all-silent blocks (nothing to play, but markPlayed must still happen). */
  private silent = new Set<{ utteranceId: bigint; timer: ReturnType<typeof setTimeout> }>();
  private nextStart = 0;
  private gain: GainNode;
  private volume: GainNode;
  /** Output level for the tutor avatar (absent on fake contexts in tests). */
  private analyser: AnalyserNode | null = null;
  private levelBuf: Float32Array | null = null;
  private tickTimer: ReturnType<typeof setInterval>;
  private playing = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly cfg: PlaybackSettings,
    private readonly client: ClientSettings,
    private readonly cb: PlaybackCallbacks = {}
  ) {
    this.orderer = new SentenceOrderer(client.PLAYBACK_GAP_TIMEOUT_MS);
    this.gain = ctx.createGain();
    // Output volume (settings popover) after the analyser tap, so the avatar still moves at low volume.
    this.volume = ctx.createGain();
    this.gain.connect(this.volume);
    this.volume.connect(ctx.destination);
    if (typeof ctx.createAnalyser === 'function') {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.levelBuf = new Float32Array(this.analyser.fftSize);
      this.gain.connect(this.analyser);
    }
    this.tickTimer = setInterval(() => {
      for (const b of this.orderer.tick(performance.now())) this.schedule(b);
      this.updatePlaying();
    }, 100);
  }

  push(block: AudioBlockIn): void {
    eventLog.log('audio.received', {
      utteranceId: block.utteranceId.toString(),
      idx: block.idx,
      bytes: block.pcm.length,
      sampleRate: block.sampleRate,
    });
    const ready = this.orderer.receive({ utteranceId: block.utteranceId, idx: block.idx, data: block }, performance.now());
    if (ready.length === 0 && this.orderer.isFlushed(block.utteranceId)) {
      eventLog.log('audio.dropped', { utteranceId: block.utteranceId.toString(), idx: block.idx });
    }
    for (const b of ready) this.schedule(b);
  }

  /** A sentence will never get audio (dropped): don't wait for it. */
  skip(utteranceId: bigint, idx: number): void {
    for (const b of this.orderer.skip(utteranceId, idx, performance.now())) this.schedule(b);
  }

  /** Stop now and forget queued audio of `utteranceId` (or of everything when omitted / 0). */
  flush(utteranceId?: bigint, reason = 'flush'): void {
    const all = !utteranceId || utteranceId === 0n;
    this.orderer.flush(utteranceId);
    for (const x of [...this.silent]) {
      if (!all && x.utteranceId !== utteranceId) continue;
      clearTimeout(x.timer);
      this.silent.delete(x);
    }
    let stopped = 0;
    this.scheduled = this.scheduled.filter(s => {
      if (!all && s.utteranceId !== utteranceId) return true;
      s.cancelled = true;
      clearTimeout(s.timer);
      try {
        s.source.stop();
      } catch {
        /* already stopped */
      }
      s.source.disconnect();
      stopped++;
      return false;
    });
    if (this.scheduled.length === 0) this.nextStart = 0;
    eventLog.log('audio.flush', { utteranceId: utteranceId?.toString() ?? '0', reason, stopped });
    this.updatePlaying();
  }

  /** Utterance whose audio is playing right now (the earliest scheduled one not yet ended), or 0n. */
  get playingUtterance(): bigint {
    const now = this.ctx.currentTime;
    const s = this.scheduled.filter(x => !x.cancelled && x.endAt > now).sort((a, b) => a.startAt - b.startAt)[0];
    return s?.utteranceId ?? 0n;
  }

  /** True while audio is scheduled to play from now on. */
  get isPlaying(): boolean {
    const now = this.ctx.currentTime;
    return this.scheduled.some(s => s.endAt > now);
  }

  /** Current output RMS, roughly 0..1 (0 when silent). Read per animation frame by the avatar. */
  level(): number {
    if (!this.analyser || !this.levelBuf) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (const v of this.levelBuf) sum += v * v;
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 4);
  }

  /** Output volume 0..1 (settings popover). */
  setVolume(v: number): void {
    this.volume.gain.value = Math.min(1, Math.max(0, v));
  }

  destroy(): void {
    clearInterval(this.tickTimer);
    this.flush(undefined, 'destroy');
    this.gain.disconnect();
    this.volume.disconnect();
    this.analyser?.disconnect();
  }

  private schedule(b: SentenceBlock<AudioBlockIn>): void {
    const { pcm, sampleRate } = b.data;
    const ints = pcm16ToInt16(pcm);
    const [s, e] = trimRange(ints, this.cfg.TRIM_SILENCE_LEVEL);
    if (e <= s) {
      eventLog.log('audio.empty', { utteranceId: b.utteranceId.toString(), idx: b.idx });
      this.scheduleSilent(b);
      return;
    }
    const samples = applyFades(int16ToFloat(ints.subarray(s, e)), sampleRate, this.cfg.FADE_MS);
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate || this.cfg.TTS_SAMPLE_RATE);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const now = this.ctx.currentTime;
    const startAt = Math.max(now + this.client.PLAYBACK_LEAD_MS / 1000, this.nextStart);
    const endAt = startAt + buffer.duration;
    this.nextStart = endAt + this.cfg.SENTENCE_PAUSE_MS / 1000;
    source.start(startAt);
    const timing: Omit<SentenceTiming, 'startMs'> = {
      durationMs: buffer.duration * 1000,
      trimStartMs: (s / (sampleRate || this.cfg.TTS_SAMPLE_RATE)) * 1000,
      wordStartsMs: b.data.wordStartsMs ?? [],
      wordEndsMs: b.data.wordEndsMs ?? [],
    };
    const item: Scheduled = { utteranceId: b.utteranceId, idx: b.idx, source, startAt, endAt, timing,
      timer: undefined as unknown as ReturnType<typeof setTimeout>, started: false, cancelled: false };
    this.watchStart(item);
    source.onended = () => {
      clearTimeout(item.timer);
      if (!item.cancelled && !item.started) this.fireStart(item);
      this.scheduled = this.scheduled.filter(x => x !== item);
      eventLog.log('audio.play_end', { utteranceId: b.utteranceId.toString(), idx: b.idx });
      this.updatePlaying();
    };
    this.scheduled.push(item);
    eventLog.log('audio.scheduled', {
      utteranceId: b.utteranceId.toString(),
      idx: b.idx,
      durationMs: Math.round(buffer.duration * 1000),
      inMs: Math.round((startAt - now) * 1000),
      trimmedStart: s,
      trimmedEnd: ints.length - e,
    });
    this.updatePlaying(true);
  }

  /** An all-silent block plays nothing, but its sentence still "starts" in its slot (markPlayed,
   *  captions, reveal), or the server would wait for it forever and the session never listens. */
  private scheduleSilent(b: SentenceBlock<AudioBlockIn>): void {
    const now = this.ctx.currentTime;
    const startAt = Math.max(now + this.client.PLAYBACK_LEAD_MS / 1000, this.nextStart);
    const entry = { utteranceId: b.utteranceId, timer: undefined as unknown as ReturnType<typeof setTimeout> };
    entry.timer = setTimeout(() => {
      this.silent.delete(entry);
      this.cb.onSentenceStart?.(b.utteranceId, b.idx, { startMs: performance.now(), durationMs: 0, trimStartMs: 0, wordStartsMs: [], wordEndsMs: [] });
    }, Math.max(0, (startAt - now) * 1000));
    this.silent.add(entry);
  }

  private watchStart(item: Scheduled): void {
    item.timer = setTimeout(() => {
      if (item.cancelled) return;
      // AudioContext time stops during suspension. A wall-clock timeout alone would reveal
      // pictures early when autoplay is blocked or the tab/audio device is suspended.
      if (this.ctx.currentTime < item.startAt || this.ctx.state !== 'running') {
        this.watchStart(item);
        return;
      }
      this.fireStart(item);
    }, Math.max(8, Math.min(100, (item.startAt - this.ctx.currentTime) * 1000)));
  }

  private fireStart(item: Scheduled): void {
    if (item.started || item.cancelled) return;
    item.started = true;
    // Word times count from the audible start: correct by how late this check ran.
    const lateMs = Math.max(0, (this.ctx.currentTime - item.startAt) * 1000);
    const timing: SentenceTiming = { ...item.timing, startMs: performance.now() - lateMs };
    eventLog.log('audio.play_start', {
      utteranceId: item.utteranceId.toString(),
      idx: item.idx,
      durationMs: Math.round(timing.durationMs),
      words: timing.wordStartsMs.length,
    });
    this.cb.onSentenceStart?.(item.utteranceId, item.idx, timing);
  }

  private updatePlaying(force?: boolean): void {
    const p = force ?? this.isPlaying;
    const playing = p || this.isPlaying;
    if (playing !== this.playing) {
      this.playing = playing;
      this.cb.onPlayingChange?.(playing);
    }
  }
}
