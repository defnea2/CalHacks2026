// Beat rows → the team's VisualDirector (presentation only; SpacetimeDB owns the lesson).
//
// `orderBeats` lists a session's beats in play order (utterance, then idx, contiguous only).
// `revealCount` decides how many of them are on the canvas:
//   - voice: a beat shows when its reply_sentence starts playing (this tab) / is `played`
//     (observer), and every beat of an utterance that is over;
//   - text: the team's local playback (cursor over the latest utterance: auto-advance by reading
//     time, pause / next / skip / replay); earlier utterances are fully shown.
// `BeatCanvasPlayer.sync` applies exactly that prefix; a shorter or different prefix (replay,
// flush) rebuilds the picture from the start, and a beat that cannot apply falls back to the
// module's authoritative `canvas_state.scene`.
import { VisualDirector } from '@tutor/visual/presentation/VisualDirector';
import type { CanvasState, VisualBeat } from '@tutor/visual/presentation/contracts';
import type { MathAction } from '@tutor/visual/presentation/math/models';
import type { LearnerAction } from '@tutor/visual/shared';
import { beatRowToVisual, contiguousBeats, type BeatRowLike } from '@tutor/visual/teaching/spacetimeModel';
import { cueSentenceOffset } from '@tutor/visual/teaching/keyframes';

export interface OrderedBeat {
  key: string;
  utteranceId: bigint;
  idx: number;
  sentenceIdx: number;
  narration: string;
  visual: VisualBeat | null;
  error: string | null;
  /** Keyframe part of the beat (0 = the beat itself; k = cues revealed with sentence sentenceIdx). */
  part: number;
}

/**
 * Per-sentence keyframes: cues whose id ends in `-s<k>` (module splitKeyframes, e.g. the equation of
 * a formalization moment) become their own reveal step on sentence `beat.sentenceIdx + k`, so each
 * visual change lands on the sentence that talks about it. A beat without such cues stays one step.
 */
export function keyframeParts(b: OrderedBeat): OrderedBeat[] {
  if (!b.visual || b.visual.cues.length < 2) return [b];
  const groups = new Map<number, VisualBeat['cues']>();
  for (const cue of b.visual.cues) {
    const k = cueSentenceOffset(cue.id);
    groups.set(k, [...(groups.get(k) ?? []), cue]);
  }
  if (groups.size < 2 || !groups.has(0)) return [b];
  return [...groups.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([k, cues]) => ({ ...b, key: k ? `${b.key}:s${k}` : b.key, sentenceIdx: b.sentenceIdx < 0 ? -1 : b.sentenceIdx + k, part: k, visual: { ...b.visual!, id: k ? `${b.visual!.id}-s${k}` : b.visual!.id, cues } }));
}

export function orderBeats(rows: readonly BeatRowLike[]): OrderedBeat[] {
  const utterances = [...new Set(rows.map(r => r.utteranceId))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: OrderedBeat[] = [];
  for (const u of utterances) {
    for (const r of contiguousBeats(rows, u)) {
      let visual: VisualBeat | null = null;
      let error: string | null = null;
      try {
        visual = beatRowToVisual(r);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      out.push(...keyframeParts({ key: `${r.utteranceId}:${r.idx}`, utteranceId: r.utteranceId, idx: r.idx, sentenceIdx: r.sentenceIdx, narration: r.narration, visual, error, part: 0 }));
    }
  }
  return out;
}

export interface RevealInput {
  beats: readonly OrderedBeat[];
  /** Voice: sentence idx started per utterance (this tab's playback, or `played` rows). */
  started: ReadonlyMap<string, readonly number[]>;
  /** The utterance is over (tutor turn written, or no longer current). */
  over: (utteranceId: bigint) => boolean;
  mode: 'voice' | 'typed';
  /** Text mode: beats shown of the latest utterance (cursor + 1). */
  textShown: number;
}

/** Number of beats (a prefix of `beats`) on the canvas. */
export function revealCount({ beats, started, over, mode, textShown }: RevealInput): number {
  if (!beats.length) return 0;
  const latest = beats[beats.length - 1]!.utteranceId;
  let n = 0;
  for (const b of beats) {
    let shown: boolean;
    if (mode === 'typed') shown = b.utteranceId !== latest || b.idx < textShown;
    else shown = over(b.utteranceId) || b.sentenceIdx < 0 || (started.get(b.utteranceId.toString()) ?? []).includes(b.sentenceIdx);
    if (!shown) break;
    n++;
  }
  return n;
}

/** Beats of the latest utterance (text-mode playback works on these: one step per beat, its
 *  keyframe parts show together by idx). */
export function latestUtteranceBeats(beats: readonly OrderedBeat[]): OrderedBeat[] {
  const last = beats.at(-1);
  return last ? beats.filter(b => b.utteranceId === last.utteranceId && b.part === 0) : [];
}

/** Reading time of one beat in text mode (the team's Lesson formula). */
export function readingMs(narration: string): number {
  return Math.max(2500, Math.min(15000, (1.2 + narration.split(/\s+/).filter(Boolean).length / 2.8) * 1000));
}

export class BeatCanvasPlayer {
  readonly director = new VisualDirector();
  private applied: string[] = [];
  error: string | null = null;

  /** Puts exactly `beats.slice(0, count)` on the canvas. Returns true if the picture changed. */
  sync(beats: readonly OrderedBeat[], count: number, fallback?: CanvasState | null): boolean {
    const want = beats.slice(0, count);
    const isPrefix = this.applied.length <= want.length && this.applied.every((k, i) => want[i]!.key === k);
    if (isPrefix && this.applied.length === want.length) return false;
    if (!isPrefix) {
      this.director.reset();
      this.applied = [];
      this.error = null;
    }
    for (const b of want.slice(this.applied.length)) {
      try {
        if (!b.visual) throw new Error(b.error ?? 'Missing visual.');
        const token = this.director.prepare(b.visual);
        this.director.narrationStarted(token);
        this.director.narrationEnded(token);
        const snap = this.director.getSnapshot();
        if (snap.status === 'error') throw new Error(snap.error ?? 'Visual cue failed.');
        this.error = null;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        // The module validated every beat against canvas_state: resync to it and continue.
        if (fallback) this.director.reset(fallback);
      }
      this.applied.push(b.key);
    }
    return true;
  }

  get shown(): number {
    return this.applied.length;
  }

  interactMath(action: MathAction) {
    const token = this.director.getSnapshot().token;
    return token ? this.director.interactMath(token, action) : null;
  }

  interactActivity(action: LearnerAction) {
    const token = this.director.getSnapshot().token;
    return token ? this.director.interactActivity(token, action) : null;
  }
}

/** canvas_state.scene → CanvasState, or null when absent/unparseable. */
export function parseScene(scene: string | undefined): CanvasState | null {
  if (!scene) return null;
  try {
    const v = JSON.parse(scene) as CanvasState;
    return v && typeof v === 'object' && Array.isArray(v.nodes) ? v : null;
  } catch {
    return null;
  }
}
