import { applyCanvasCommands } from '../canvasState';
import { emptyCanvas } from '../contracts';
import { compileMathCommand } from '../math/compact';
import { VoiceCanvasContentSchema } from './contracts';
import { compileGroundedMoment } from '../math/grounding';

/** One semantic check shared by generation and playback; no browser APIs. */
export function validateVoiceCanvasContent(input: unknown, options: { requireGrounding?: boolean } = {}) {
  const content = VoiceCanvasContentSchema.parse(input);
  if (content.moments[0].sentenceOffset !== 0 || ['keep', 'update'].includes(content.moments[0].visual.kind))
    throw new Error('Start each canvas explanation with a complete picture at sentence offset zero. Even a continuation must restate the full starting visual; then use updates at offsets 1, 2, etc.');
  let canvas = emptyCanvas();
  const grounded = options.requireGrounding || content.moments.some(m => m.teaching !== undefined);
  const narrated = grounded || content.moments.some(m => m.narration !== undefined);
  content.moments.forEach((m, index) => {
    if (narrated && ((!grounded && !m.narration) || m.sentenceOffset !== index))
      throw new Error('A narrated canvas needs narration on every moment and contiguous offsets 0, 1, 2, etc.');
    if (index && m.sentenceOffset <= content.moments[index - 1].sentenceOffset)
      throw new Error('Canvas sentence offsets must increase.');
    if (m.interactive && index !== content.moments.length - 1)
      throw new Error('Only the final picture may enable learner controls.');
    if (grounded) {
      if (!m.teaching) throw new Error('Every generated moment requires a structured teaching intent; free-form narration cannot demonstrate a mathematical claim.');
      if (m.teaching.action === 'question' && index !== content.moments.length - 1) throw new Error('Ask the learner only after the demonstration; a question must be final.');
      const compiled = compileGroundedMoment({ ...m, teaching: m.teaching }, canvas);
      m.visual = compiled.visual;
      m.narration = compiled.narration;
      m.teaching = compiled.teaching;
      canvas = compiled.after;
    } else canvas = applyCanvasCommands(canvas, compileMathCommand(m.visual, canvas, { ...m, title: content.title }));
  });
  if (grounded) content.title = canvas.math!.visual.title;
  return content;
}
