import { TOOL_NAMES } from '@tutor/shared';
import { str, type ToolModule } from './types';
import { validateVoiceCanvasContent } from '../../../src/presentation/voice/validate';

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
  // The board is revealed by FUTURE speech. Return to the model after the tool so
  // a preamble followed by a tool call cannot silently finish the utterance.
  kind: 'query',
  async handler(args, ctx) {
    // pack-literal-ok: semantic validator for the renderer's compact command protocol.
    // Library tasks remain authored content; new generated demonstrations have one verified path.
    if (str(args.kind) !== 'math_canvas' && !str(args.taskKey)) // pack-literal-ok
      throw new Error('Use math_canvas with structured teaching for generated demonstrations, or an existing library taskKey.');
    const canvas = str(args.kind) === 'math_canvas' ? validateVoiceCanvasContent(args.content, { requireGrounding: true }) : undefined; // pack-literal-ok
    const lines = canvas?.moments.map(m => m.narration);
    const narrated = lines?.every((line): line is string => typeof line === 'string');
    if (narrated && !ctx.narrate) throw new Error('Narration is unavailable or a canvas was already narrated in this reply.');
    // A self-narrated canvas is timed by its own moments (sentence offsets from the next sentence);
    // otherwise the item may carry an inline marker ⟦id⟧ and appears at that word.
    const anchor = narrated ? undefined : ctx.anchor?.(args.id);
    await ctx.transport.showBoardItem({
      sessionId: ctx.sessionId,
      utteranceId: ctx.utteranceId,
      sentenceIdx: anchor ? anchor.sentenceIdx : ctx.nextSentenceIdx,
      markerPos: anchor ? anchor.pos : -1,
      kind: str(args.kind),
      content: json(canvas ?? args.content),
      taskKey: str(args.taskKey),
      expectedAnswer: json(args.expectedAnswer),
    });
    if (narrated) {
      await ctx.narrate!(lines as string[]);
      return { text: 'Canvas and its narration delivered. Wait for the learner.', narrated: true };
    }
    const content = args.content as { moments?: { sentenceOffset: number; visual: unknown }[] } | undefined;
    if (Array.isArray(content?.moments)) {
      const moments = content.moments;
      return `Board accepted with ${moments.length} visual moments. You MUST now narrate every moment in this reply. `
        + `Speak ${moments.at(-1)!.sentenceOffset + 1} short sentences after this tool: `
        + moments.map(m => `sentence ${m.sentenceOffset + 1}: ${JSON.stringify(m.visual)}`).join('; ')
        + '. Do not stop after only a prediction question when later moments remain. Do not call another board tool before completing these sentences.';
    }
    // Anchored at an inline marker: the speech about it was already said, nothing to follow up.
    if (anchor) return { text: 'ok' };
    return 'Board accepted. Now refer to it in your next short spoken sentence.';
  },
};
