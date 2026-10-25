import { AnimatedMathBoard } from './AnimatedMathBoard';
import { getRenderer, parseContent } from './registry';
import { revealState, type UtteranceProgress } from './reveal';
import type { AnswerProps } from './types';

export interface BoardItemView {
  id: bigint;
  idx: number;
  kind: string;
  content: string;
  visible: boolean;
  utteranceId: bigint;
  sentenceIdx: number;
  answerState: string;
  lastAnswer: string;
}

interface Props {
  items: BoardItemView[];
  progress: Map<string, UtteranceProgress>;
  serverOver: (u: bigint) => boolean;
  /** Absent in read-only views (observer). */
  allowCanvasInteraction?: boolean;
  onSubmitAnswer?: (itemId: bigint, answer: string) => Promise<void>;
}

export function Board({ items, progress, serverOver, onSubmitAnswer, allowCanvasInteraction = false }: Props) {
  const shown = items.filter(i => i.visible).sort((a, b) => a.idx - b.idx);
  const mathItems = shown.filter(i => i.kind === 'math_canvas').map(i => ({
    id: i.id.toString(), order: i.idx, utteranceId: i.utteranceId.toString(), sentenceIdx: i.sentenceIdx,
    content: parseContent(i.content),
  }));
  const started = new Map([...progress].map(([id, p]) => [id, p.started]));
  return (
    <div data-testid="board" className="flex flex-col gap-3">
      {shown.length === 0 ? <div className="canvas-welcome"><span className="welcome-mark" aria-hidden="true">↗</span><h2>Let’s see how it works.</h2><p>Start with your question.<br />The picture will take shape as we talk.</p></div> : null}
      <AnimatedMathBoard items={mathItems} started={started} interactive={allowCanvasInteraction} />
      {shown.filter(item => item.kind !== 'math_canvas').map(item => {
        const p = progress.get(item.utteranceId.toString()) ?? { maxStarted: -1, started: [], over: serverOver(item.utteranceId) };
        const reveal = revealState(item, p);
        const { renderer: R, known } = getRenderer(item.kind);
        const answer: AnswerProps = {
          state: item.answerState,
          last: item.lastAnswer,
          submit: onSubmitAnswer ? a => onSubmitAnswer(item.id, a) : undefined,
        };
        return (
          <div
            key={item.id.toString()}
            data-testid="board-item"
            data-kind={item.kind}
            data-idx={item.idx}
            data-id={item.id.toString()}
            data-revealed={reveal.revealed ? 'true' : 'false'}
            data-known={known ? 'true' : 'false'}
            hidden={!reveal.revealed}
            className="rounded-xl border bg-card p-4 shadow-xs animate-[fadein_.35s_ease-out]"
          >
            {reveal.revealed ? <R content={parseContent(item.content)} reveal={reveal} answer={answer} {...(known ? {} : { kind: item.kind })} /> : null}
          </div>
        );
      })}
    </div>
  );
}
