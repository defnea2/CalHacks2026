import { useEffect, useState, useSyncExternalStore } from 'react';
import { TeachingCanvas } from '../../../src/presentation/TeachingCanvas';
import { SpeechCanvasPlayer, type SpeechCanvasItem, type StartedSentences } from '../../../src/presentation/voice/SpeechCanvasPlayer';
import type { RendererProps } from './types';

export function AnimatedMathBoard({ items, started, interactive = false }: {
  items: SpeechCanvasItem[]; started: StartedSentences; interactive?: boolean;
}) {
  const [player] = useState(() => new SpeechCanvasPlayer());
  const snapshot = useSyncExternalStore(player.director.subscribe, player.director.getSnapshot, player.director.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    player.sync(items, started, interactive);
    setError(player.error);
  }, [player, items, started, interactive]);
  if (!items.length) return null;
  return <div data-testid="animated-math-board">
    {snapshot.canvas.math ? <TeachingCanvas canvas={snapshot.canvas}
      interactionEnabled={interactive && player.director.canInteract()}
      onMathAction={action => { player.interact(action); }} />
      : <p className="py-6 text-sm text-muted-foreground">The picture will appear with the explanation.</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-700">This picture could not be shown. Ask the tutor to try again.</p>}
  </div>;
}

/** Registry compatibility; the Board host groups all math items into one persistent canvas. */
export function MathCanvasRenderer({ content }: RendererProps) {
  return <AnimatedMathBoard items={[{ id: 'preview', order: 0, utteranceId: '0', sentenceIdx: 0, content }]}
    started={new Map()} />;
}
