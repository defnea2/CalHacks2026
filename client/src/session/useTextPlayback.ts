// Text-mode presentation state (the team's Lesson playback): a cursor over the latest
// utterance's beats that advances by reading time unless paused; Next / Skip / Replay.
// Pure presentation: nothing here is written to SpacetimeDB.
import { useCallback, useEffect, useRef, useState } from 'react';
import { readingMs, type OrderedBeat } from '../lesson/beatPlayer';

export interface TextPlayback {
  /** Beats of the latest utterance on the canvas (≥ 1 once one arrived). */
  shown: number;
  total: number;
  paused: boolean;
  setPaused: (v: boolean | ((p: boolean) => boolean)) => void;
  next: () => void;
  skip: () => void;
  replay: () => void;
  /** Bumped by replay: the canvas rebuilds from its start. */
  run: number;
}

export function useTextPlayback(latest: readonly OrderedBeat[], enabled: boolean, reducedMotion = false): TextPlayback {
  const utterance = latest[0]?.utteranceId.toString() ?? '';
  const [state, setState] = useState({ utterance, shown: latest.length ? 1 : 0, run: 0 });
  const [paused, setPaused] = useState(reducedMotion);
  const lastAdvance = useRef(performance.now());
  const total = latest.length;

  // A new utterance starts at its first beat (shown at once, like the team's first beat).
  let shown = state.shown;
  if (state.utterance !== utterance) shown = total ? 1 : 0;
  else if (shown === 0 && total) shown = 1;
  useEffect(() => {
    if (state.utterance !== utterance || state.shown !== shown) {
      lastAdvance.current = performance.now();
      setState(s => ({ ...s, utterance, shown }));
    }
  }, [utterance, shown, state.utterance, state.shown]);

  useEffect(() => {
    if (!enabled || paused || shown >= total || shown === 0) return;
    const wait = Math.max(0, readingMs(latest[shown - 1]!.narration) - (performance.now() - lastAdvance.current));
    const t = setTimeout(() => {
      lastAdvance.current = performance.now();
      setState(s => (s.utterance === utterance ? { ...s, shown: Math.min(total, s.shown + 1) } : s));
    }, wait);
    return () => clearTimeout(t);
  }, [enabled, paused, shown, total, latest, utterance]);

  const next = useCallback(() => {
    lastAdvance.current = performance.now();
    setState(s => ({ ...s, shown: Math.min(total, s.shown + 1) }));
  }, [total]);
  const skip = useCallback(() => setState(s => ({ ...s, shown: total })), [total]);
  const replay = useCallback(() => {
    lastAdvance.current = performance.now();
    setPaused(reducedMotion);
    setState(s => ({ ...s, shown: total ? 1 : 0, run: s.run + 1 }));
  }, [total, reducedMotion]);

  return { shown, total, paused, setPaused, next, skip, replay, run: state.run };
}
