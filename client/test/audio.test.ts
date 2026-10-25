import { describe, expect, it } from 'vitest';
import { ChunkAccumulator, floatToPcm16, int16ToFloat, pcm16ToInt16, rmsDbfs } from '../src/audio/pcm';
import { NoiseMonitor, noiseStateFor } from '../src/audio/noise';
import { applyFades, SentenceOrderer, trimRange } from '../src/audio/playbackLogic';
import { loadSettings } from '../src/config';

describe('pcm', () => {
  it('float <-> PCM16 LE round trip', () => {
    const f = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
    const bytes = floatToPcm16(f);
    expect(bytes.length).toBe(14);
    const ints = pcm16ToInt16(bytes);
    expect(Array.from(ints)).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768]);
    expect(bytes[2]).toBe(0x00); // little endian: 16384 = 0x4000
    expect(bytes[3]).toBe(0x40);
    const back = int16ToFloat(ints);
    expect(back[1]).toBeCloseTo(0.5, 3);
  });

  it('pcm16ToInt16 handles an odd byteOffset', () => {
    const buf = new Uint8Array(5);
    const sub = buf.subarray(1);
    sub[0] = 0x01;
    sub[1] = 0x00;
    sub[2] = 0xff;
    sub[3] = 0xff;
    expect(Array.from(pcm16ToInt16(sub))).toEqual([1, -1]);
  });

  it('rmsDbfs', () => {
    expect(rmsDbfs(new Float32Array(100).fill(1))).toBeCloseTo(0);
    expect(rmsDbfs(new Float32Array(100).fill(0.1))).toBeCloseTo(-20);
    expect(rmsDbfs(new Float32Array(100))).toBe(-100);
  });

  it('ChunkAccumulator emits >= 150 ms of whole frames', () => {
    const acc = new ChunkAccumulator(2400);
    const out: number[] = [];
    for (let i = 0; i < 20; i++) {
      const c = acc.push(new Float32Array(512));
      if (c) out.push(c.length);
    }
    expect(out).toEqual([2560, 2560, 2560, 2560]);
    acc.push(new Float32Array(512));
    expect(acc.take().length).toBe(512);
    expect(acc.take().length).toBe(0);
  });
});

describe('NoiseMonitor', () => {
  const cfg = { ...loadSettings('').voice, ...loadSettings('').client };

  it('seeds with the mean of the first second, then follows an EMA (tau 2 s)', () => {
    const n = new NoiseMonitor(cfg);
    for (let i = 0; i < 31; i++) n.update(i % 2 ? -60 : -40, 0.1, 32); // ~1 s
    expect(n.floorDb!).toBeGreaterThan(-51);
    expect(n.floorDb!).toBeLessThan(-49);
    // 2 s at -30: about 63% of the way
    for (let i = 0; i < 62; i++) n.update(-30, 0.1, 32);
    expect(n.floorDb!).toBeGreaterThan(-40);
    expect(n.floorDb!).toBeLessThan(-35);
  });

  it('ignores speech frames (prob >= 0.3)', () => {
    const n = new NoiseMonitor(cfg);
    for (let i = 0; i < 40; i++) n.update(-60, 0.1, 32);
    for (let i = 0; i < 200; i++) n.update(-10, 0.9, 32);
    expect(n.floorDb!).toBeCloseTo(-60);
    expect(n.state).toBe('quiet');
  });

  it('energy gate and states', () => {
    const n = new NoiseMonitor(cfg);
    expect(n.passesGate(-90)).toBe(true); // no floor yet
    for (let i = 0; i < 40; i++) n.update(-45, 0.1, 32);
    expect(n.state).toBe('moderate');
    expect(n.passesGate(-36)).toBe(false);
    expect(n.passesGate(-35)).toBe(true);
    expect(noiseStateFor(-51, cfg)).toBe('quiet');
    expect(noiseStateFor(-34, cfg)).toBe('noisy');
  });
});

describe('playback logic', () => {
  it('trims leading/trailing silence', () => {
    const s = new Int16Array([0, 10, -50, 300, 5000, -400, 20, 0]);
    expect(trimRange(s, 200)).toEqual([3, 6]);
    expect(trimRange(new Int16Array([1, 2, 3]), 200)).toEqual([0, 0]);
  });

  it('fades in and out', () => {
    const f = applyFades(new Float32Array(1000).fill(1), 24000, 8); // 192 samples
    expect(f[0]).toBe(0);
    expect(f[96]).toBeCloseTo(0.5, 2);
    expect(f[500]).toBe(1);
    expect(f[999]).toBe(0);
  });

  it('releases strictly by idx, buffering out-of-order arrivals', () => {
    const o = new SentenceOrderer<string>();
    const u = 5n;
    expect(o.receive({ utteranceId: u, idx: 1, data: 'b' })).toEqual([]);
    expect(o.receive({ utteranceId: u, idx: 2, data: 'c' })).toEqual([]);
    expect(o.receive({ utteranceId: u, idx: 0, data: 'a' }).map(b => b.data)).toEqual(['a', 'b', 'c']);
    expect(o.receive({ utteranceId: u, idx: 1, data: 'dup' })).toEqual([]);
    expect(o.receive({ utteranceId: u, idx: 3, data: 'd' }).map(b => b.data)).toEqual(['d']);
  });

  it('a new utterance switches; the old one is retired; flushed ones stay silent', () => {
    const o = new SentenceOrderer<string>();
    o.receive({ utteranceId: 1n, idx: 0, data: 'a0' });
    o.receive({ utteranceId: 1n, idx: 2, data: 'a2' });
    expect(o.receive({ utteranceId: 2n, idx: 0, data: 'b0' }).map(b => b.data)).toEqual(['b0']);
    expect(o.receive({ utteranceId: 1n, idx: 1, data: 'a1' })).toEqual([]);
    o.flush(2n);
    expect(o.receive({ utteranceId: 2n, idx: 1, data: 'b1' })).toEqual([]);
    expect(o.receive({ utteranceId: 3n, idx: 0, data: 'c0' }).map(b => b.data)).toEqual(['c0']);
  });

  it('skips a missing index after the gap timeout or when told', () => {
    const o = new SentenceOrderer<string>(1000);
    o.receive({ utteranceId: 1n, idx: 0, data: 'a' }, 0);
    expect(o.receive({ utteranceId: 1n, idx: 2, data: 'c' }, 100)).toEqual([]);
    expect(o.tick(500)).toEqual([]);
    expect(o.tick(1200).map(b => b.data)).toEqual(['c']);
    o.receive({ utteranceId: 1n, idx: 4, data: 'e' }, 2000);
    expect(o.skip(1n, 3).map(b => b.data)).toEqual(['e']);
  });
});

describe('config', () => {
  it('reads defaults and URL overrides', () => {
    const s = loadSettings('?vad_turn_ms=900&barge_in_threshold=0.8&sentence_pause_ms=150&db=other&junk=1&vad_phrase_ms=abc');
    expect(s.voice.VAD_TURN_MS).toBe(900);
    expect(s.voice.BARGE_IN_THRESHOLD).toBe(0.8);
    expect(s.voice.VAD_PHRASE_MS).toBe(300);
    expect(s.playback.SENTENCE_PAUSE_MS).toBe(150);
    expect(s.spacetimeDb).toBe('other');
    expect(s.spacetimeUri).toBe('ws://127.0.0.1:3000');
    expect(loadSettings('', { VITE_SPACETIME_DB: 'x' }).spacetimeDb).toBe('x');
  });
});
