// AudioContext not running (autoplay blocked, device suspended): resume on push / pointerdown,
// "Tap for sound" after ~1 s, hidden again once it runs.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_BLOCKED_AFTER_MS, AudioUnlock } from '../src/audio/audioUnlock';

function fakeCtx(state: AudioContextState, resumeWorks = false) {
  const ctx = {
    state,
    onstatechange: null as null | (() => void),
    resume: vi.fn(async () => {
      if (resumeWorks) {
        ctx.state = 'running';
        ctx.onstatechange?.();
      }
    }),
  };
  return ctx;
}

afterEach(() => vi.useRealTimers());

describe('AudioUnlock', () => {
  it('a suspended context that will not resume shows the hint after ~1 s; a tap that unlocks hides it', async () => {
    vi.useFakeTimers();
    const ctx = fakeCtx('suspended');
    const target = new EventTarget();
    const states: boolean[] = [];
    const u = new AudioUnlock(ctx as never, b => states.push(b), target);
    u.poke();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(AUDIO_BLOCKED_AFTER_MS - 1);
    expect(states).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(states).toEqual([true]);
    // The user taps anywhere: resume() inside the gesture succeeds.
    ctx.resume.mockImplementation(async () => {
      ctx.state = 'running';
      ctx.onstatechange?.();
    });
    target.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    expect(states).toEqual([true, false]);
    u.destroy();
  });

  it('a context that resumes in time never shows the hint', async () => {
    vi.useFakeTimers();
    const ctx = fakeCtx('suspended', true);
    const states: boolean[] = [];
    const u = new AudioUnlock(ctx as never, b => states.push(b), new EventTarget());
    u.poke();
    await Promise.resolve();
    vi.advanceTimersByTime(AUDIO_BLOCKED_AFTER_MS * 2);
    expect(states).toEqual([]);
    u.poke(); // running: no further resume
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    u.destroy();
  });
});
