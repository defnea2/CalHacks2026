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
  timer: ReturnType<typeof setTimeout>;
}

export class PlaybackQueue {
  private orderer: SentenceOrderer<AudioBlockIn>;
  private scheduled: Scheduled[] = [];
  private nextStart = 0;
  private gain: GainNode;
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
    this.gain.connect(ctx.destination);
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
    let stopped = 0;
    this.scheduled = this.scheduled.filter(s => {
      if (!all && s.utteranceId !== utteranceId) return true;
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

  /** True while audio is scheduled to play from now on. */
  get isPlaying(): boolean {
    const now = this.ctx.currentTime;
    return this.scheduled.some(s => s.endAt > now);
  }

  destroy(): void {
    clearInterval(this.tickTimer);
    this.flush(undefined, 'destroy');
    this.gain.disconnect();
  }

  private schedule(b: SentenceBlock<AudioBlockIn>): void {
    const { pcm, sampleRate } = b.data;
    const ints = pcm16ToInt16(pcm);
    const [s, e] = trimRange(ints, this.cfg.TRIM_SILENCE_LEVEL);
    if (e <= s) {
      eventLog.log('audio.empty', { utteranceId: b.utteranceId.toString(), idx: b.idx });
      this.fireStart(b.utteranceId, b.idx, 0, { startMs: performance.now(), durationMs: 0, trimStartMs: 0, wordStartsMs: [], wordEndsMs: [] });
      return;
    }
    const samples = applyFades(int16ToFloat(ints.subarray(s, e)), sampleRate, this.cfg.FADE_MS);
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate || this.cfg.TTS_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const now = this.ctx.currentTime;
    const startAt = Math.max(now + this.client.PLAYBACK_LEAD_MS / 1000, this.nextStart);
    const endAt = startAt + buffer.duration;
    this.nextStart = endAt + this.cfg.SENTENCE_PAUSE_MS / 1000;
    source.start(startAt);
    const inMs = Math.max(0, (startAt - now) * 1000);
    const timing: SentenceTiming = {
      startMs: performance.now() + inMs,
      durationMs: buffer.duration * 1000,
      trimStartMs: (s / (sampleRate || this.cfg.TTS_SAMPLE_RATE)) * 1000,
      wordStartsMs: b.data.wordStartsMs ?? [],
      wordEndsMs: b.data.wordEndsMs ?? [],
    };
    const timer = this.fireStart(b.utteranceId, b.idx, inMs, timing);
    const item: Scheduled = { utteranceId: b.utteranceId, idx: b.idx, source, startAt, endAt, timer };
    source.onended = () => {
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

  private fireStart(utteranceId: bigint, idx: number, delayMs: number, timing: SentenceTiming): ReturnType<typeof setTimeout> {
    // Flushing clears these timers, so a timer that fires belongs to audio that really plays.
    return setTimeout(() => {
      eventLog.log('audio.play_start', {
        utteranceId: utteranceId.toString(),
        idx,
        durationMs: Math.round(timing.durationMs),
        words: timing.wordStartsMs.length,
      });
      this.cb.onSentenceStart?.(utteranceId, idx, timing);
    }, delayMs);
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
