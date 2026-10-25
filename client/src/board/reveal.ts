// Voice/board sync: an item tagged (utteranceId, sentenceIdx) appears when that sentence
// starts playing. Kind-agnostic, pure.
import type { RevealState } from './types';

export interface RevealInput {
  utteranceId: bigint;
  sentenceIdx: number;
}

export interface UtteranceProgress {
  /** Highest sentence idx of the utterance that started playing (or was dropped); -1 = none. */
  maxStarted: number;
  /** Exact indices: dropped/gap-skipped audio never reveals a visual. */
  started: number[];
  /** The utterance is finished: nothing of it will play any more. */
  over: boolean;
}

export function revealState(item: RevealInput, progress: UtteranceProgress | undefined): RevealState {
  if (item.utteranceId === 0n) return { revealed: true, progress: Infinity };
  if (!progress) return { revealed: false, progress: 0 };
  if (!progress.started.includes(item.sentenceIdx)) return { revealed: false, progress: 0 };
  let n = 0;
  while (progress.started.includes(item.sentenceIdx + n)) n++;
  return n > 0 ? { revealed: true, progress: n } : { revealed: false, progress: 0 };
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
  localStarted: Map<string, number[]>,
  serverOver: (u: bigint) => boolean,
  startedStatuses: readonly string[],
  finishedStatuses: readonly string[]
): Map<string, UtteranceProgress> {
  const out = new Map<string, UtteranceProgress & { open: boolean; u: bigint }>();
  for (const s of sentences) {
    const k = s.utteranceId.toString();
    const p = out.get(k) ?? { maxStarted: -1, started: [], over: false, open: false, u: s.utteranceId };
    if (startedStatuses.includes(s.status)) { p.maxStarted = Math.max(p.maxStarted, s.idx); p.started.push(s.idx); }
    if (!finishedStatuses.includes(s.status)) p.open = true;
    out.set(k, p);
  }
  for (const [k, indices] of localStarted) {
    const p = out.get(k) ?? { maxStarted: -1, started: [], over: false, open: false, u: BigInt(k) };
    p.maxStarted = Math.max(p.maxStarted, ...indices);
    p.started.push(...indices);
    out.set(k, p);
  }
  const result = new Map<string, UtteranceProgress>();
  for (const [k, p] of out) result.set(k, { maxStarted: p.maxStarted, started: [...new Set(p.started)].sort((a, b) => a - b), over: !p.open && serverOver(p.u) });
  return result;
}
