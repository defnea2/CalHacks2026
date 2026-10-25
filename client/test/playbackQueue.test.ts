// PlaybackQueue scheduling against a fake AudioContext: the 10 ms lead never schedules in the
// past (no underrun), blocks of a burst are back to back with the sentence pause (no overlap,
// no gap), and every block starts and ends on a fade (no click).
import { afterEach, describe, expect, it } from 'vitest';
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
