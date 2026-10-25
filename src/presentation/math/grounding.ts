import { applyCanvasCommands } from '../canvasState';
import type { CanvasState } from '../contracts';
import { CompactMathCommandSchema, compileMathCommand } from './compact';
import { canonicalMathVisual, compileTeaching } from './teaching';

/** Compile a mathematical operation and its speech as one unit. Both generation
 * transports call this before releasing anything to a learner. */
export function compileGroundedMoment(input: { visual: unknown; teaching: unknown; interactive: boolean; showEquation: boolean }, before: CanvasState) {
  let visual = CompactMathCommandSchema.parse(input.visual);
  let commands = compileMathCommand(visual, before, { ...input, title: 'Math' });
  let after = applyCanvasCommands(before, commands);
  const canonical = canonicalMathVisual(after.math!.visual);
  if (visual.kind !== 'keep' && visual.kind !== 'update') {
    const { id: _id, title: _title, interactive: _interactive, showEquation: _show, focus: _focus, ...shape } = canonical;
    visual = CompactMathCommandSchema.parse(shape);
    commands = compileMathCommand(visual, before, { ...input, title: canonical.title });
    after = applyCanvasCommands(before, commands);
  }
  const { narration, intent } = compileTeaching(input.teaching, canonical, before.math ? canonicalMathVisual(before.math.visual) : undefined);
  if (intent.action === 'question' && input.showEquation) throw new Error('Hide the answer equation when asking a prediction.');
  return { visual, commands, after, narration, teaching: intent };
}
