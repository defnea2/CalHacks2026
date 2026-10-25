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
  // The board is revealed by FUTURE speech. Return to the model after the tool so
  // a preamble followed by a tool call cannot silently finish the utterance.
  kind: 'query',
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
    return 'Board accepted. Now refer to it in your next short spoken sentence. If it has moments, speak one sentence per moment in sentenceOffset order, describing that exact change. The first sentence reveals moment zero. Do not call another board tool before narrating this one.';
  },
};
