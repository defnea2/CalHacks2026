import { TOOL_NAMES } from '@tutor/shared';
import { str, type ToolModule } from './types';
import { validateVoiceCanvasContent } from '../../../src/presentation/voice/validate';

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
    // pack-literal-ok: semantic validator for the renderer's compact command protocol.
    if (str(args.kind) === 'math_canvas') validateVoiceCanvasContent(args.content); // pack-literal-ok
    await ctx.transport.showBoardItem({
      sessionId: ctx.sessionId,
      utteranceId: ctx.utteranceId,
      sentenceIdx: ctx.nextSentenceIdx,
      kind: str(args.kind),
      content: json(args.content),
      taskKey: str(args.taskKey),
      expectedAnswer: json(args.expectedAnswer),
    });
    const content = args.content as { moments?: { sentenceOffset: number; visual: unknown }[] } | undefined;
    if (Array.isArray(content?.moments)) {
      const moments = content.moments;
      return `Board accepted with ${moments.length} visual moments. You MUST now narrate every moment in this reply. `
        + `Speak ${moments.at(-1)!.sentenceOffset + 1} short sentences after this tool: `
        + moments.map(m => `sentence ${m.sentenceOffset + 1}: ${JSON.stringify(m.visual)}`).join('; ')
        + '. Do not stop after only a prediction question when later moments remain. Do not call another board tool before completing these sentences.';
    }
    return 'Board accepted. Now refer to it in your next short spoken sentence.';
  },
};
