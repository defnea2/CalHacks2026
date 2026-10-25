// PCM helpers. Pure functions, unit-tested.

/** Float32 [-1, 1] -> PCM16 little-endian bytes. */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return out;
}

/** PCM16 little-endian bytes -> Int16 samples (copy, handles odd offsets). */
export function pcm16ToInt16(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.length / 2);
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export function int16ToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]! / 0x8000;
  return out;
}

/** RMS level of a frame in dBFS (full-scale sine ~ -3 dBFS, silence -> floor). */
export function rmsDbfs(frame: Float32Array, floor = -100): number {
  if (frame.length === 0) return floor;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  const rms = Math.sqrt(sum / frame.length);
  if (rms <= 0) return floor;
  return Math.max(floor, 20 * Math.log10(rms));
}

export function concatFloat(parts: Float32Array[]): Float32Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Accumulates frames and emits chunks of at least `chunkSamples` (whole frames, no splitting). */
export class ChunkAccumulator {
  private parts: Float32Array[] = [];
  private count = 0;
  constructor(private readonly chunkSamples: number) {}

  /** Adds a frame; returns a full chunk when one is ready. */
  push(frame: Float32Array): Float32Array | null {
    this.parts.push(frame);
    this.count += frame.length;
    if (this.count >= this.chunkSamples) return this.take();
    return null;
  }

  /** Remaining audio (possibly empty). */
  take(): Float32Array {
    const out = concatFloat(this.parts);
    this.parts = [];
    this.count = 0;
    return out;
  }

  get samples(): number {
    return this.count;
  }
}
