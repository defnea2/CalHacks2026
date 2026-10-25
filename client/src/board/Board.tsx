import { useEffect, useRef, useState } from 'react';
import { eventLog } from '../lib/debug';
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
  /** Inline marker offset in the tagged sentence's speech; -1 = none. */
  markerPos: number;
  answerState: string;
  lastAnswer: string;
}

interface Props {
  items: BoardItemView[];
  progress: Map<string, UtteranceProgress>;
  serverOver: (u: bigint) => boolean;
  /** Absent in read-only views (observer). */
  onSubmitAnswer?: (itemId: bigint, answer: string) => Promise<void>;
  /** When an item's marker word plays (performance.now() clock); undefined = at sentence start. */
  markerAt?: (item: BoardItemView) => number | undefined;
}

export function Board({ items, progress, serverOver, onSubmitAnswer, markerAt }: Props) {
  const shown = items.filter(i => i.visible).sort((a, b) => a.idx - b.idx);
  const [, setTick] = useState(0);
  const now = performance.now();
  const states = shown.map(item => {
    const p = progress.get(item.utteranceId.toString()) ?? { maxStarted: -1, over: serverOver(item.utteranceId) };
    return revealState(item, p, { now, markerAt: item.markerPos >= 0 ? markerAt?.(item) : undefined });
  });
  // Re-render when the next marker word is due.
  const nextAt = Math.min(Infinity, ...states.map(r => r.revealAt ?? Infinity));
  useEffect(() => {
    if (!Number.isFinite(nextAt)) return;
    const timer = setTimeout(() => setTick(t => t + 1), Math.max(0, nextAt - performance.now()));
    return () => clearTimeout(timer);
  }, [nextAt]);
  // Debug/E2E: when each item first arrived (board.seen) and first became visible (board.reveal).
  const logged = useRef(new Set<string>());
  const seen = useRef(new Set<string>());
  useEffect(() => {
    shown.forEach((item, i) => {
      const k = item.id.toString();
      if (!seen.current.has(k)) {
        seen.current.add(k);
        eventLog.log('board.seen', { id: k, utteranceId: item.utteranceId.toString(), sentenceIdx: item.sentenceIdx, markerPos: item.markerPos });
      }
      if (!states[i]!.revealed || logged.current.has(k)) return;
      logged.current.add(k);
      eventLog.log('board.reveal', {
        id: k,
        utteranceId: item.utteranceId.toString(),
        sentenceIdx: item.sentenceIdx,
        markerPos: item.markerPos,
      });
    });
  });
  return (
    <div data-testid="board" className="flex flex-col gap-3">
      {shown.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">The board is empty.</p> : null}
      {shown.map((item, i) => {
        const reveal = states[i]!;
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
