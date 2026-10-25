import { applyCanvasCommands } from '../canvasState';
import { emptyCanvas, type CanvasState } from '../contracts';
import { compileMathCommand } from '../math/compact';
import { VoiceCanvasContentSchema } from './contracts';
import { compileGroundedMoment } from '../math/grounding';

/** One semantic check shared by generation and playback; no browser APIs. */
export function validateVoiceCanvasContent(input: unknown, options: { requireGrounding?: boolean } = {}) {
  const content = VoiceCanvasContentSchema.parse(input);
  if (content.moments[0].sentenceOffset !== 0 || ['keep', 'update'].includes(content.moments[0].visual.kind))
    throw new Error('Start each canvas explanation with a complete picture at sentence offset zero. Even a continuation must restate the full starting visual; then use updates at offsets 1, 2, etc.');
  let canvas = emptyCanvas();
  let lastTransitionBefore: CanvasState | undefined;
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
      const compiled = compileGroundedMoment({ ...m, teaching: m.teaching }, canvas, lastTransitionBefore);
      m.visual = compiled.visual;
      m.narration = compiled.narration;
      m.teaching = compiled.teaching;
      if (index && m.narration === content.moments[index - 1].narration) throw new Error('Repeated teaching claim: remove the redundant moment.');
      if (compiled.visual.kind === 'update' && compiled.changed) lastTransitionBefore = canvas;
      else if (!['update', 'keep'].includes(compiled.visual.kind)) lastTransitionBefore = undefined;
      canvas = compiled.after;
    } else canvas = applyCanvasCommands(canvas, compileMathCommand(m.visual, canvas, { ...m, title: content.title }));
  });
  if (grounded) {
    if (content.moments.every(m => m.teaching?.action === 'observe')) throw new Error('An observation alone is not a completed lesson. Include the requested calculation, comparison, transformation, or a final learner question in this plan.');
    content.title = canvas.math!.visual.title;
  }
  return content;
}
