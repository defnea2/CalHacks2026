// PlaybackQueue scheduling against a fake AudioContext: the 10 ms lead never schedules in the
// past (no underrun), blocks of a burst are back to back with the sentence pause (no overlap,
// no gap), and every block starts and ends on a fade (no click).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackQueue } from '../src/audio/PlaybackQueue';
import { floatToPcm16 } from '../src/audio/pcm';
import { loadSettings } from '../src/config';

interface FakeSource {
  buffer: { duration: number; data: Float32Array } | null;
  startedAt?: number;
  onended: (() => void) | null;
  connect(): void;
  disconnect(): void;
  start(t: number): void;
  stop(): void;
}

class FakeAudioContext {
  currentTime = 0;
  state = 'running';
  destination = {};
  sources: FakeSource[] = [];
  createGain() {
    return { connect() {}, disconnect() {} };
  }
  createBuffer(_ch: number, length: number, rate: number) {
    const data = new Float32Array(length);
    return { duration: length / rate, data, copyToChannel: (s: Float32Array) => data.set(s) };
  }
  createBufferSource(): FakeSource {
    const s: FakeSource = {
      buffer: null,
      onended: null,
      connect() {},
      disconnect() {},
      start(t: number) {
        s.startedAt = t;
      },
      stop() {},
    };
    this.sources.push(s);
    return s;
  }
}

const RATE = 24000;
/** A sentence of `ms` loud audio as PCM16 bytes. */
function sentence(ms: number): Uint8Array {
  const n = Math.round((RATE * ms) / 1000);
  const f = new Float32Array(n).map((_, i) => 0.5 * Math.sin(i / 5));
  return floatToPcm16(f);
}

let q: PlaybackQueue | undefined;
afterEach(() => q?.destroy());

describe('PlaybackQueue scheduling', () => {
  const s = loadSettings('');

  it('uses a 10 ms lead by default', () => {
    expect(s.client.PLAYBACK_LEAD_MS).toBe(10);
  });

  it('first block starts after the lead, later blocks back to back with the pause, never in the past', () => {
    const ctx = new FakeAudioContext();
    ctx.currentTime = 5;
    q = new PlaybackQueue(ctx as unknown as AudioContext, s.playback, s.client);
    q.push({ utteranceId: 1n, idx: 0, pcm: sentence(500), sampleRate: RATE });
    ctx.currentTime = 5.2; // block 1 arrives while block 0 plays
    q.push({ utteranceId: 1n, idx: 1, pcm: sentence(300), sampleRate: RATE });
    const [a, b] = ctx.sources;
    expect(a!.startedAt).toBeCloseTo(5 + s.client.PLAYBACK_LEAD_MS / 1000, 6);
    const aEnd = a!.startedAt! + a!.buffer!.duration;
    expect(b!.startedAt).toBeCloseTo(aEnd + s.playback.SENTENCE_PAUSE_MS / 1000, 6);
    // Block 2 arrives late, after everything ended: starts after the lead from now, not in the past.
    ctx.currentTime = 10;
    q.push({ utteranceId: 1n, idx: 2, pcm: sentence(200), sampleRate: RATE });
    expect(ctx.sources[2]!.startedAt).toBeCloseTo(10 + s.client.PLAYBACK_LEAD_MS / 1000, 6);
    for (const src of ctx.sources) expect(src.startedAt!).toBeGreaterThan(0);
  });

  it('every scheduled block starts and ends at zero (fades: no click)', () => {
    const ctx = new FakeAudioContext();
    q = new PlaybackQueue(ctx as unknown as AudioContext, s.playback, s.client);
    q.push({ utteranceId: 1n, idx: 0, pcm: sentence(400), sampleRate: RATE });
    const d = ctx.sources[0]!.buffer!.data;
    expect(Math.abs(d[0]!)).toBe(0);
    expect(Math.abs(d[d.length - 1]!)).toBe(0);
  });
});

describe('PlaybackQueue sentence timing (inline markers)', () => {
  const s = loadSettings('');
  it('reports start on the performance clock, trimmed duration, trimmed lead and word times', async () => {
    const ctx = new FakeAudioContext();
    ctx.currentTime = 1;
    const got: unknown[] = [];
    q = new PlaybackQueue(ctx as unknown as AudioContext, s.playback, s.client, { onSentenceStart: (u, idx, t) => got.push({ u, idx, t }) });
    const lead = new Uint8Array(Math.round(RATE * 0.25) * 2); // 250 ms of silence, trimmed
    const audio = sentence(500);
    const pcm = new Uint8Array(lead.length + audio.length);
    pcm.set(lead);
    pcm.set(audio, lead.length);
    const before = performance.now();
    q.push({ utteranceId: 3n, idx: 0, pcm, sampleRate: RATE, wordStartsMs: [260, 500], wordEndsMs: [480, 740] });
    ctx.currentTime = 1 + s.client.PLAYBACK_LEAD_MS / 1000; // audio clock exactly at the start
    await new Promise(r => setTimeout(r, s.client.PLAYBACK_LEAD_MS + 30));
    expect(got).toHaveLength(1);
    const { t } = got[0] as { t: { startMs: number; durationMs: number; trimStartMs: number; wordStartsMs: number[] } };
    // fired by the audio-clock watcher (>= 8 ms poll); startMs = when the audio really started
    expect(t.startMs).toBeGreaterThanOrEqual(before);
    expect(t.startMs).toBeLessThan(before + 200);
    expect(t.trimStartMs).toBeGreaterThan(240);
    expect(t.trimStartMs).toBeLessThan(260);
    expect(t.durationMs).toBeGreaterThan(480);
    expect(t.durationMs).toBeLessThanOrEqual(500);
    expect(t.wordStartsMs).toEqual([260, 500]);
  });
});

// --- team: audio-clock visual triggers ---
function harness() {
  vi.useFakeTimers();
  const sources: { onended: (() => void) | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const ctx = { currentTime: 0, state: 'running', destination: {},
    createGain: () => ({ connect() {}, disconnect() {} }),
    createBuffer: (_channels: number, n: number, rate: number) => ({ duration: n / rate, copyToChannel() {} }),
    createBufferSource: () => {
      const s = { onended: null, start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn() };
      sources.push(s); return s;
    },
  };
  const cfg = loadSettings('');
  const onStart = vi.fn();
  const q = new PlaybackQueue(ctx as unknown as AudioContext, cfg.playback, cfg.client, { onSentenceStart: onStart });
  const push = (idx = 0) => q.push({ utteranceId: 7n, idx, sampleRate: 24000, pcm: new Uint8Array(new Int16Array(2400).fill(1000).buffer) });
  return { q, ctx, sources, push, onStart };
}
afterEach(() => { vi.useRealTimers(); });
describe('audio-clock visual triggers', () => {
  it('does not reveal while the audio clock is suspended, and fires once on actual start', () => {
    const { q, ctx, push, onStart } = harness();
    ctx.state = 'suspended'; push();
    vi.advanceTimersByTime(1000);
    expect(onStart).not.toHaveBeenCalled();
    ctx.state = 'running'; ctx.currentTime = 0.08;
    vi.advanceTimersByTime(100);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0]!.slice(0, 2)).toEqual([7n, 0]);
    vi.advanceTimersByTime(1000);
    expect(onStart).toHaveBeenCalledTimes(1);
    q.destroy();
  });
  it('flush cancels pending visual triggers and ignores late audio for that utterance', () => {
    const { q, ctx, push, onStart, sources } = harness();
    push(); q.flush(7n); ctx.currentTime = 1;
    sources[0]!.onended?.(); // stopping a buffer also emits ended; it must not become a start
    push(); vi.advanceTimersByTime(2000);
    expect(onStart).not.toHaveBeenCalled();
    q.destroy();
  });
  it('a gap-skipped sentence does not generate a fabricated start event', () => {
    const { q, ctx, push, onStart } = harness();
    push(1); q.skip(7n, 0); ctx.currentTime = 0.08;
    vi.advanceTimersByTime(100);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0]!.slice(0, 2)).toEqual([7n, 1]);
    q.destroy();
  });
});
