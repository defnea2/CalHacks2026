import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  fft400,
  fitToWindow,
  melFilters,
  N_FRAMES,
  N_MELS,
  SMART_TURN_SAMPLES,
  smartTurnFeatures,
} from '../src/audio/smartTurnFeatures';

// Reference values computed once offline with transformers' WhisperFeatureExtractor(chunk_length=8)
// exactly as pipecat-ai/smart-turn inference.py calls it (see fixture "source").
interface Case {
  samples: number;
  mean: number;
  min: number;
  max: number;
  columns: number[][];
  prob: number;
}
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/smart-turn-features.json', import.meta.url)), 'utf8')
) as { frames: number[]; cases: Case[] };

/** Same synthetic signal as the fixture generator (float64 formula, then float32). */
function signal(n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / 16000;
    out[i] =
      0.3 * Math.sin(2 * Math.PI * 220 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t)) +
      0.1 * Math.sin(2 * Math.PI * (500 + 1500 * t) * t) +
      0.02 * Math.sin(12.9898 * i);
  }
  return out;
}

describe('smartTurnFeatures', () => {
  it('fft400 matches a naive DFT', () => {
    const re = new Float64Array(400);
    const im = new Float64Array(400);
    for (let i = 0; i < 400; i++) re[i] = Math.sin(i * 0.37) + 0.5 * Math.cos(i * 1.91) + (i % 7) * 0.01;
    const oRe = new Float64Array(400);
    const oIm = new Float64Array(400);
    fft400(re, im, oRe, oIm);
    for (const k of [0, 1, 7, 50, 199, 200, 333]) {
      let sr = 0;
      let si = 0;
      for (let n = 0; n < 400; n++) {
        sr += re[n]! * Math.cos((-2 * Math.PI * k * n) / 400);
        si += re[n]! * Math.sin((-2 * Math.PI * k * n) / 400);
      }
      expect(oRe[k]).toBeCloseTo(sr, 8);
      expect(oIm[k]).toBeCloseTo(si, 8);
    }
  });

  it('fitToWindow keeps the end and pads at the start', () => {
    const short = fitToWindow(new Float32Array([1, 2, 3]));
    expect(short.length).toBe(SMART_TURN_SAMPLES);
    expect(Array.from(short.subarray(SMART_TURN_SAMPLES - 3))).toEqual([1, 2, 3]);
    expect(short[0]).toBe(0);
    const long = new Float32Array(SMART_TURN_SAMPLES + 5).map((_, i) => i);
    const fit = fitToWindow(long);
    expect(fit[0]).toBe(5);
    expect(fit.at(-1)).toBe(SMART_TURN_SAMPLES + 4);
  });

  it('mel filters: 80 slaney triangles over 201 bins, none empty', () => {
    const m = melFilters();
    expect(m.length).toBe(80 * 201);
    for (let r = 0; r < 80; r++) expect(Math.max(...m.subarray(r * 201, (r + 1) * 201))).toBeGreaterThan(0);
  });

  for (const c of fixture.cases) {
    it(`matches the reference log-mel (${c.samples / 16000} s of audio)`, () => {
      const f = smartTurnFeatures(signal(c.samples));
      expect(f.length).toBe(N_MELS * N_FRAMES);
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const v of f) {
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      expect(Math.abs(sum / f.length - c.mean)).toBeLessThan(1e-4);
      expect(Math.abs(min - c.min)).toBeLessThan(1e-4);
      expect(Math.abs(max - c.max)).toBeLessThan(1e-4);
      let worst = 0;
      fixture.frames.forEach((frame, j) => {
        for (let m = 0; m < N_MELS; m++) worst = Math.max(worst, Math.abs(f[m * N_FRAMES + frame]! - c.columns[j]![m]!));
      });
      expect(worst).toBeLessThan(2e-4);
    });
  }
});
