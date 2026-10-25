// Voice/board sync: an item tagged (utteranceId, sentenceIdx) appears when that sentence
// starts playing; with an inline marker (markerPos >= 0) at the marker's word inside it, timed
// from TTS word timestamps or estimated from the sentence duration. Kind-agnostic, pure.
import type { RevealState } from './types';

export interface RevealInput {
  utteranceId: bigint;
  sentenceIdx: number;
  /** Inline marker offset in the speech of that sentence; -1 / absent = reveal at its start. */
  markerPos?: number;
}

export interface UtteranceProgress {
  /** Highest sentence idx of the utterance that started playing (or was dropped); -1 = none. */
  maxStarted: number;
  /** The utterance is finished: nothing of it will play any more. */
  over: boolean;
}

export interface RevealOptions {
  /** Current time on the clock of `markerAt` (performance.now() in the app). */
  now?: number;
  /** When the item's marker word plays (same clock), if this tab knows when its sentence
   *  started. Undefined: reveal when the sentence starts (observer, reload, no audio). */
  markerAt?: number;
}

export function revealState(item: RevealInput, progress: UtteranceProgress | undefined, opts: RevealOptions = {}): RevealState {
  if (item.utteranceId === 0n) return { revealed: true, progress: Infinity };
  if (!progress) return { revealed: false, progress: 0 };
  const n = progress.maxStarted - item.sentenceIdx + 1;
  // Marker inside the sentence that is playing now: wait for its word (a later sentence
  // having started means the word was said). Checked before `over`: the utterance counts as
  // over as soon as its last sentence *starts* (markPlayed), while that sentence still plays.
  if (n === 1 && (item.markerPos ?? -1) >= 0 && opts.markerAt !== undefined && (opts.now ?? 0) < opts.markerAt) {
    return { revealed: false, progress: 0, revealAt: opts.markerAt };
  }
  if (progress.over) return { revealed: true, progress: Infinity };
  if (n <= 0) return { revealed: false, progress: 0 };
  return { revealed: true, progress: n };
}

/** Playback timing of one sentence on this tab (from the PlaybackQueue). */
export interface SentenceTiming {
  /** When its (trimmed) audio started playing, performance.now() clock. */
  startMs: number;
  /** Duration of the trimmed audio. */
  durationMs: number;
  /** Leading silence trimmed off before playback (TTS word times count from the untrimmed start). */
  trimStartMs: number;
  /** TTS word timestamps (ms from the untrimmed start); empty when the provider gave none. */
  wordStartsMs: number[];
  wordEndsMs: number[];
}

/**
 * Offset (ms after the sentence's playback start) of the word at/after `pos` in `speech`.
 * Exact with TTS word timestamps: the speech's whitespace tokens map 1:1 to the TTS words (or
 * proportionally when the counts differ); a marker after the last word maps to the end of the
 * last word. Without timestamps: duration × pos / speech length.
 */
export function markerOffsetMs(speech: string, pos: number, t: SentenceTiming): number {
  const clamp = (ms: number) => Math.max(0, Math.min(t.durationMs, ms));
  const n = Math.min(t.wordStartsMs.length, t.wordEndsMs.length);
  if (n > 0) {
    const starts = [...speech.matchAll(/\S+/g)].map(m => m.index!);
    const k = starts.findIndex(st => st >= pos);
    if (k < 0) return clamp(t.wordEndsMs[n - 1]! - t.trimStartMs);
    const w = n === starts.length ? k : Math.min(n - 1, Math.round((k * n) / Math.max(1, starts.length)));
    return clamp(t.wordStartsMs[w]! - t.trimStartMs);
  }
  return clamp((t.durationMs * Math.max(0, pos)) / Math.max(1, speech.length));
}

export interface SentenceLike {
  utteranceId: bigint;
  idx: number;
  status: string;
}

/**
 * Progress per utterance from sentence rows (+ sentences this tab started playing locally).
 * `serverOver(u)`: the server no longer works on u (tutor turn appended or another utterance current).
 * An utterance is over only when that holds and none of its sentences can still play.
 */
export function utteranceProgress(
  sentences: SentenceLike[],
  localStarted: Map<string, number>,
  serverOver: (u: bigint) => boolean,
  startedStatuses: readonly string[],
  finishedStatuses: readonly string[]
): Map<string, UtteranceProgress> {
  const out = new Map<string, UtteranceProgress & { open: boolean; u: bigint }>();
  for (const s of sentences) {
    const k = s.utteranceId.toString();
    const p = out.get(k) ?? { maxStarted: -1, over: false, open: false, u: s.utteranceId };
    if (startedStatuses.includes(s.status)) p.maxStarted = Math.max(p.maxStarted, s.idx);
    if (!finishedStatuses.includes(s.status)) p.open = true;
    out.set(k, p);
  }
  for (const [k, idx] of localStarted) {
    const p = out.get(k) ?? { maxStarted: -1, over: false, open: false, u: BigInt(k) };
    p.maxStarted = Math.max(p.maxStarted, idx);
    out.set(k, p);
  }
  const result = new Map<string, UtteranceProgress>();
  for (const [k, p] of out) result.set(k, { maxStarted: p.maxStarted, over: !p.open && serverOver(p.u) });
  return result;
}
