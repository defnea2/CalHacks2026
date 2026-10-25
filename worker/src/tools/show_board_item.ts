import { TOOL_NAMES } from '@tutor/shared';
import { str, type ToolModule } from './types';

const json = (v: unknown): string => {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'string') return v; // model sent JSON as a string already
  return JSON.stringify(v);
};

/** Tagged with the current utterance and a reveal anchor: the sentence + speech offset of its
 *  inline marker ⟦id⟧ when the text has one (revealed at that word), else the index of the next
 *  sentence (revealed when that sentence starts playing). */
export const showBoardItem: ToolModule = {
  name: TOOL_NAMES.showBoardItem,
  kind: 'action',
  async handler(args, ctx) {
    const anchor = ctx.anchor?.(args.id);
    await ctx.transport.showBoardItem({
      sessionId: ctx.sessionId,
      utteranceId: ctx.utteranceId,
      sentenceIdx: anchor ? anchor.sentenceIdx : ctx.nextSentenceIdx,
      markerPos: anchor ? anchor.pos : -1,
      kind: str(args.kind),
      content: json(args.content),
      taskKey: str(args.taskKey),
      expectedAnswer: json(args.expectedAnswer),
    });
    return 'ok';
  },
};
