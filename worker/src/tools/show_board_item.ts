import { TOOL_NAMES } from '@tutor/shared';
import { str, type ToolModule } from './types';

const json = (v: unknown): string => {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'string') return v; // model sent JSON as a string already
  return JSON.stringify(v);
};

/** Tagged with the current utterance and the index of the next sentence, so the client reveals
 *  the item when that sentence starts playing. */
export const showBoardItem: ToolModule = {
  name: TOOL_NAMES.showBoardItem,
  kind: 'action',
  async handler(args, ctx) {
    await ctx.transport.showBoardItem({
      sessionId: ctx.sessionId,
      utteranceId: ctx.utteranceId,
      sentenceIdx: ctx.nextSentenceIdx,
      kind: str(args.kind),
      content: json(args.content),
      taskKey: str(args.taskKey),
      expectedAnswer: json(args.expectedAnswer),
    });
    return 'ok';
  },
};
