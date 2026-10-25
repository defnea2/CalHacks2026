// Smart Turn v3 input features (pure, no browser APIs): the preprocessing of the reference
// implementation (pipecat-ai/smart-turn inference.py), i.e. the last 8 s of 16 kHz mono audio,
// zero-padded at the START, zero-mean/unit-variance normalised, then Whisper's log-mel
// spectrogram (transformers WhisperFeatureExtractor(chunk_length=8)):
//   n_fft 400, hop 160, periodic Hann, centred frames with reflect padding, power spectrum,
//   80 Slaney mel filters 0-8 kHz (Slaney norm), log10(max(mel, 1e-10)), last frame dropped,
//   clamp to (max - 8), then (x + 4) / 4.
// Output layout matches the model input `input_features` [1, 80, 800]: row-major [mel][frame].
// Checked against reference values in test/fixtures/smart-turn-features.json.

export const SMART_TURN_SAMPLE_RATE = 16000;
export const SMART_TURN_SAMPLES = 8 * SMART_TURN_SAMPLE_RATE;
export const N_FFT = 400;
export const HOP = 160;
export const N_MELS = 80;
export const N_FRAMES = SMART_TURN_SAMPLES / HOP; // 800
const N_BINS = N_FFT / 2 + 1; // 201

/** Last 8 s of `pcm`, or `pcm` with zeros in front up to 8 s. */
export function fitToWindow(pcm: Float32Array): Float32Array {
  if (pcm.length === SMART_TURN_SAMPLES) return pcm;
  if (pcm.length > SMART_TURN_SAMPLES) return pcm.subarray(pcm.length - SMART_TURN_SAMPLES);
  const out = new Float32Array(SMART_TURN_SAMPLES);
  out.set(pcm, SMART_TURN_SAMPLES - pcm.length);
  return out;
}

// ---- mel filter bank (transformers.audio_utils.mel_filter_bank, slaney/slaney) ----

function hzToMel(f: number): number {
  if (f < 1000) return (3 * f) / 200;
  return 15 + (Math.log(f / 1000) * 27) / Math.log(6.4);
}

function melToHz(m: number): number {
  if (m < 15) return (200 * m) / 3;
  return 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15));
}

let melCache: Float64Array | null = null;

/** [N_MELS][N_BINS] row-major. */
export function melFilters(): Float64Array {
  if (melCache) return melCache;
  const melMin = hzToMel(0);
  const melMax = hzToMel(8000);
  const filt = new Float64Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) filt[i] = melToHz(melMin + ((melMax - melMin) * i) / (N_MELS + 1));
  const out = new Float64Array(N_MELS * N_BINS);
  for (let m = 0; m < N_MELS; m++) {
    const lo = filt[m]!;
    const c = filt[m + 1]!;
    const hi = filt[m + 2]!;
    const enorm = 2 / (hi - lo);
    for (let k = 0; k < N_BINS; k++) {
      const f = (k * (SMART_TURN_SAMPLE_RATE / 2)) / (N_BINS - 1);
      const down = (f - lo) / (c - lo);
      const up = (hi - f) / (hi - c);
      out[m * N_BINS + k] = Math.max(0, Math.min(down, up)) * enorm;
    }
  }
  melCache = out;
  return out;
}

// ---- mixed-radix FFT for N = 400 (= 2·2·2·2·5·5) ----

interface FftPlan {
  n: number;
  factors: number[];
  cos: Float64Array;
  sin: Float64Array;
}

function makePlan(n: number): FftPlan {
  const factors: number[] = [];
  let r = n;
  for (const p of [4, 2, 3, 5]) {
    while (r % p === 0) {
      factors.push(p);
      r /= p;
    }
  }
  for (let p = 7; r > 1; p += 2) {
    while (r % p === 0) {
      factors.push(p);
      r /= p;
    }
  }
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  return { n, factors, cos, sin };
}

/** Recursive decimation in time: out[k] = Σ_r W_N^{rk} · FFT_{N/p}(in[r::p])[k mod N/p]. */
function fftRec(
  plan: FftPlan,
  inRe: Float64Array,
  inIm: Float64Array,
  inOff: number,
  stride: number,
  n: number,
  fi: number,
  outRe: Float64Array,
  outIm: Float64Array,
  outOff: number
): void {
  if (n === 1) {
    outRe[outOff] = inRe[inOff]!;
    outIm[outOff] = inIm[inOff]!;
    return;
  }
  const p = plan.factors[fi]!;
  const m = n / p;
  // sub-FFTs land contiguously: block r = out[outOff + r*m .. + m)
  for (let r = 0; r < p; r++) fftRec(plan, inRe, inIm, inOff + r * stride, stride * p, m, fi + 1, outRe, outIm, outOff + r * m);
  const tw = plan.n / n; // twiddle step in the full-size table
  const tRe = new Float64Array(p);
  const tIm = new Float64Array(p);
  for (let k = 0; k < m; k++) {
    // twiddled inputs of this butterfly
    for (let r = 0; r < p; r++) {
      const idx = outOff + r * m + k;
      const w = ((r * k) % n) * tw;
      const c = plan.cos[w]!;
      const s = plan.sin[w]!;
      const a = outRe[idx]!;
      const b = outIm[idx]!;
      tRe[r] = a * c - b * s;
      tIm[r] = a * s + b * c;
    }
    // size-p DFT across them
    for (let q = 0; q < p; q++) {
      let sr = 0;
      let si = 0;
      for (let r = 0; r < p; r++) {
        const w = ((r * q * m) % n) * tw;
        const c = plan.cos[w]!;
        const s = plan.sin[w]!;
        sr += tRe[r]! * c - tIm[r]! * s;
        si += tRe[r]! * s + tIm[r]! * c;
      }
      outRe[outOff + q * m + k] = sr;
      outIm[outOff + q * m + k] = si;
    }
  }
}

let planCache: FftPlan | null = null;

/** Complex FFT of length 400 (exposed for tests). */
export function fft400(re: Float64Array, im: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
  planCache ??= makePlan(N_FFT);
  fftRec(planCache, re, im, 0, 1, N_FFT, 0, outRe, outIm, 0);
}

let windowCache: Float64Array | null = null;
function hann(): Float64Array {
  if (windowCache) return windowCache;
  const w = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  windowCache = w;
  return w;
}

/** Float32Array(80 * 800), row-major [mel][frame], ready for `input_features` [1, 80, 800]. */
export function smartTurnFeatures(pcm: Float32Array): Float32Array {
  const x = fitToWindow(pcm);
  const n = x.length;

  // zero-mean, unit-variance over the whole (padded) window, as the reference does
  let sum = 0;
  for (let i = 0; i < n; i++) sum += x[i]!;
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (x[i]! - mean) * (x[i]! - mean);
  const std = Math.sqrt(v / n + 1e-7);
  const half = N_FFT / 2;
  const padded = new Float64Array(n + N_FFT);
  for (let i = 0; i < n; i++) padded[i + half] = (x[i]! - mean) / std;
  for (let i = 1; i <= half; i++) {
    padded[half - i] = padded[half + i]!; // reflect (edge sample not repeated)
    padded[half + n - 1 + i] = padded[half + n - 1 - i]!;
  }

  const win = hann();
  const mel = melFilters();
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const oRe = new Float64Array(N_FFT);
  const oIm = new Float64Array(N_FFT);
  const power = new Float64Array(N_BINS);
  const out = new Float32Array(N_MELS * N_FRAMES);
  let maxLog = -Infinity;
  for (let f = 0; f < N_FRAMES; f++) {
    // frame N_FRAMES (the 801st) is dropped by the reference
    const start = f * HOP;
    for (let i = 0; i < N_FFT; i++) {
      re[i] = padded[start + i]! * win[i]!;
      im[i] = 0;
    }
    fft400(re, im, oRe, oIm);
    for (let k = 0; k < N_BINS; k++) power[k] = oRe[k]! * oRe[k]! + oIm[k]! * oIm[k]!;
    for (let m = 0; m < N_MELS; m++) {
      let s = 0;
      const row = m * N_BINS;
      for (let k = 0; k < N_BINS; k++) s += mel[row + k]! * power[k]!;
      const l = Math.log10(Math.max(s, 1e-10));
      out[m * N_FRAMES + f] = l;
      if (l > maxLog) maxLog = l;
    }
  }
  const floor = maxLog - 8;
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i]!, floor) + 4) / 4;
  return out;
}
