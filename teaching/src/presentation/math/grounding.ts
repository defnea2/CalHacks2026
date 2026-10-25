import { applyCanvasCommands } from '../canvasState';
import type { CanvasState } from '../contracts';
import { CompactMathCommandSchema, compileMathCommand } from './compact';
import { canonicalMathVisual, compileTeaching, resolveMathTarget, mathStateKey } from './teaching';

/** Compile a mathematical operation and its speech as one unit. The voice
 * generation boundary calls this before releasing anything to a learner. */
export function compileGroundedMoment(input: { visual: unknown; teaching: unknown; interactive: boolean; showEquation: boolean }, before: CanvasState, lastTransitionBefore?: CanvasState) {
  let visual = CompactMathCommandSchema.parse(input.visual);
  if (visual.kind === 'update' && before.math) {
    const current = canonicalMathVisual(before.math.visual);
    visual.changes = visual.changes.map(change => {
      if (change.type === 'set_bar') return { ...change, barId: resolveMathTarget(current, change.barId) };
      if (change.type === 'move_marker') return { ...change, markerId: resolveMathTarget(current, change.markerId) };
      if (change.type === 'set_focus' && change.target && (current.kind === 'bars' || current.kind === 'number_line')) return { ...change, target: resolveMathTarget(current, change.target) };
      return change;
    });
  }
  let commands = compileMathCommand(visual, before, { ...input, title: 'Math' });
  let after = applyCanvasCommands(before, commands);
  const canonical = canonicalMathVisual(after.math!.visual);
  const previous = before.math?.visual;
  if (previous?.kind === 'parallelogram' && canonical.kind === 'parallelogram' && visual.kind === 'update' &&
      (previous.stage !== 'slant' || canonical.stage !== 'slant') &&
      (previous.base !== canonical.base || previous.height !== canonical.height || previous.shear !== canonical.shear))
    throw new Error('A cut-and-slide transition must keep the same pieces: base, height and shear cannot change during the proof.');
  if (visual.kind !== 'keep' && visual.kind !== 'update') {
    const { id: _id, title: _title, interactive: _interactive, showEquation: _show, focus: _focus, ...shape } = canonical;
    visual = CompactMathCommandSchema.parse(shape);
    commands = compileMathCommand(visual, before, { ...input, title: canonical.title });
    after = applyCanvasCommands(before, commands);
  }
  const changed = !!previous && mathStateKey(canonicalMathVisual(previous)) !== mathStateKey(canonical);
  // A later spoken sentence may explain the transformation just displayed.
  // Its evidence is the actual previous transition, never an invented baseline.
  const evidence = !changed && (visual.kind === 'keep' || visual.kind === 'update') && lastTransitionBefore
    ? lastTransitionBefore : before;
  const { narration, intent } = compileTeaching(input.teaching, canonical, evidence.math ? canonicalMathVisual(evidence.math.visual) : undefined);
  if (['change', 'conserve'].includes(intent.action) && visual.kind !== 'update' && !(visual.kind === 'keep' && lastTransitionBefore))
    throw new Error('A transformation must update existing objects, not replace the picture.');
  if (intent.action === 'question' && input.showEquation) throw new Error('Hide the answer equation when asking a prediction.');
  return { visual, commands, after, narration, teaching: intent, changed };
}
