// Pure parts of the PlaybackQueue: silence trimming, fades, and strict sentence ordering.

/** Index range [start, end) of the samples above `level` (absolute, of 32768). Empty -> [0, 0]. */
export function trimRange(samples: Int16Array, level: number): [number, number] {
  let start = 0;
  while (start < samples.length && Math.abs(samples[start]!) < level) start++;
  if (start === samples.length) return [0, 0];
  let end = samples.length;
  while (end > start && Math.abs(samples[end - 1]!) < level) end--;
  return [start, end];
}

/** In-place linear fade-in and fade-out of `fadeMs` each (clamped to half the buffer). */
export function applyFades(samples: Float32Array, sampleRate: number, fadeMs: number): Float32Array {
  const n = Math.min(Math.floor((fadeMs * sampleRate) / 1000), Math.floor(samples.length / 2));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    samples[i]! *= g;
    samples[samples.length - 1 - i]! *= g;
  }
  return samples;
}

export interface SentenceBlock<T> {
  utteranceId: bigint;
  idx: number;
  data: T;
}

/**
 * Releases sentence blocks strictly by idx within the current utterance (0, 1, 2, ...),
 * buffering blocks that arrive early. A block of a new utterance switches to it and drops
 * whatever of the old one was still buffered. Flushed utterances are ignored for good.
 */
export class SentenceOrderer<T> {
  current: bigint | null = null;
  nextIdx = 0;
  private buffered = new Map<number, SentenceBlock<T>>();
  private flushed = new Set<bigint>();
  /** When the oldest missing index started blocking (ms, caller clock). */
  private waitingSince: number | null = null;

  constructor(private readonly gapTimeoutMs = 6000) {}

  receive(block: SentenceBlock<T>, now = 0): SentenceBlock<T>[] {
    if (this.flushed.has(block.utteranceId)) return [];
    if (this.current !== block.utteranceId) {
      // Utterance ids are worker-chosen (not necessarily ordered): retire the old one so late
      // blocks of it never restart it.
      if (this.current !== null) this.flushed.add(this.current);
      this.current = block.utteranceId;
      this.nextIdx = 0;
      this.buffered.clear();
      this.waitingSince = null;
    }
    if (block.idx < this.nextIdx) return []; // duplicate / already skipped
    this.buffered.set(block.idx, block);
    return this.drain(now);
  }

  /** Call periodically: skips a missing index after the gap timeout. */
  tick(now: number): SentenceBlock<T>[] {
    if (this.buffered.size === 0 || this.waitingSince === null) return [];
    if (now - this.waitingSince < this.gapTimeoutMs) return [];
    this.nextIdx = Math.min(...this.buffered.keys());
    this.waitingSince = null;
    return this.drain(now);
  }

  /** Skip an index known to never arrive (e.g. sentence `dropped`). */
  skip(utteranceId: bigint, idx: number, now = 0): SentenceBlock<T>[] {
    if (utteranceId !== this.current || idx !== this.nextIdx) return [];
    this.nextIdx++;
    return this.drain(now);
  }

  /** Flush one utterance (or the current one when 0n / undefined). */
  flush(utteranceId?: bigint): void {
    const u = utteranceId && utteranceId !== 0n ? utteranceId : this.current;
    if (u !== null && u !== undefined) this.flushed.add(u);
    if (u === this.current || u === null || u === undefined) {
      this.buffered.clear();
      this.waitingSince = null;
    }
  }

  isFlushed(utteranceId: bigint): boolean {
    return this.flushed.has(utteranceId);
  }

  get pending(): number {
    return this.buffered.size;
  }

  private drain(now: number): SentenceBlock<T>[] {
    const out: SentenceBlock<T>[] = [];
    while (this.buffered.has(this.nextIdx)) {
      out.push(this.buffered.get(this.nextIdx)!);
      this.buffered.delete(this.nextIdx);
      this.nextIdx++;
    }
    this.waitingSince = this.buffered.size > 0 ? (this.waitingSince ?? now) : null;
    return out;
  }
}
