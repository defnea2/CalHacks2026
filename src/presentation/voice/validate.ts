import { applyCanvasCommands } from '../canvasState';
import { emptyCanvas } from '../contracts';
import { compileMathCommand } from '../math/compact';
import { VoiceCanvasContentSchema } from './contracts';

/** One semantic check shared by generation and playback; no browser APIs. */
export function validateVoiceCanvasContent(input: unknown) {
  const content = VoiceCanvasContentSchema.parse(input);
  if (content.moments[0].sentenceOffset !== 0 || ['keep', 'update'].includes(content.moments[0].visual.kind))
    throw new Error('Start each canvas explanation with a complete picture at sentence offset zero. Even a continuation must restate the full starting visual; then use updates at offsets 1, 2, etc.');
  let canvas = emptyCanvas();
  const narrated = content.moments.some(m => m.narration !== undefined);
  content.moments.forEach((m, index) => {
    if (narrated && (!m.narration || m.sentenceOffset !== index))
      throw new Error('A narrated canvas needs narration on every moment and contiguous offsets 0, 1, 2, etc.');
    if (index && m.sentenceOffset <= content.moments[index - 1].sentenceOffset)
      throw new Error('Canvas sentence offsets must increase.');
    if (m.interactive && index !== content.moments.length - 1)
      throw new Error('Only the final picture may enable learner controls.');
    canvas = applyCanvasCommands(canvas, compileMathCommand(m.visual, canvas, { ...m, title: content.title }));
  });
  return content;
}
