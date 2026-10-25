// The main area: the team's TeachingCanvas, driven by `beat` rows through BeatCanvasPlayer.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { TeachingCanvas } from '@tutor/visual/presentation/TeachingCanvas';
import type { CanvasState } from '@tutor/visual/presentation/contracts';
import type { MathAction } from '@tutor/visual/presentation/math/models';
import type { LearnerAction } from '@tutor/visual/shared';
import { BeatCanvasPlayer, type OrderedBeat } from '../lesson/beatPlayer';
import { eventLog } from '../lib/debug';

export interface LessonCanvasProps {
  beats: readonly OrderedBeat[];
  /** Prefix of `beats` on the canvas. */
  count: number;
  /** Rebuild from the start when this changes (replay). */
  run?: number;
  fallback: CanvasState | null;
  interactive: boolean;
  /** A learner manipulation the local canvas accepted: the team action, forwarded to submitInteraction. */
  onInteraction?: (kind: 'math' | 'activity', payload: unknown) => void;
}

export function LessonCanvas({ beats, count, run = 0, fallback, interactive, onInteraction }: LessonCanvasProps) {
  const [player, setPlayer] = useState(() => new BeatCanvasPlayer());
  const lastRun = useRef(run);
  useEffect(() => {
    if (lastRun.current !== run) {
      lastRun.current = run;
      setPlayer(new BeatCanvasPlayer());
    }
  }, [run]);
  const snapshot = useSyncExternalStore(player.director.subscribe, player.director.getSnapshot, player.director.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const before = player.shown;
    if (player.sync(beats, count, fallback)) {
      for (const b of beats.slice(before, count)) eventLog.log('lesson.beat_shown', { key: b.key, sentenceIdx: b.sentenceIdx });
    }
    if (player.error) eventLog.log('lesson.beat_error', { error: player.error });
    setError(player.error);
  }, [player, beats, count, fallback]);
  const canvas = snapshot.canvas;
  const empty = !canvas.math && !canvas.activity && !canvas.nodes.length;
  return (
    <div data-testid="lesson-canvas" data-beats={beats.length} data-shown={Math.min(count, beats.length)} className="lesson-canvas">
      {empty ? null : (
        <TeachingCanvas
          canvas={canvas}
          minimal
          interactionEnabled={interactive && player.director.canInteract()}
          onMathAction={(action: MathAction) => {
            const e = player.interactMath(action);
            if (e) onInteraction?.('math', e.action);
          }}
          onActivityAction={(action: LearnerAction) => {
            const e = player.interactActivity(action);
            if (e) onInteraction?.('activity', action);
          }}
        />
      )}
      {error && <p role="alert" className="mt-2 text-sm text-red-700">This picture could not be shown exactly. Ask the tutor to try again.</p>}
    </div>
  );
}
