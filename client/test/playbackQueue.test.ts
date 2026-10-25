import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackQueue } from '../src/audio/PlaybackQueue';
import { loadSettings } from '../src/config';

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
afterEach(() => vi.useRealTimers());
describe('audio-clock visual triggers', () => {
  it('does not reveal while the audio clock is suspended, and fires once on actual start', () => {
    const { q, ctx, push, onStart } = harness();
    ctx.state = 'suspended'; push();
    vi.advanceTimersByTime(1000);
    expect(onStart).not.toHaveBeenCalled();
    ctx.state = 'running'; ctx.currentTime = 0.08;
    vi.advanceTimersByTime(100);
    expect(onStart).toHaveBeenCalledExactlyOnceWith(7n, 0);
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
    expect(onStart).toHaveBeenCalledExactlyOnceWith(7n, 1);
    q.destroy();
  });
});
