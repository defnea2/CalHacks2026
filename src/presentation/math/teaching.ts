import { z } from 'zod';
import { MathVisualSchema, geometryArea, type MathVisual } from './models';

/** A renderer capability, not an unrestricted topic name. New capabilities need
 * geometry, a fact evaluator and regression examples before being advertised. */
export const TeachingIntentSchema = z.object({
  concept: z.enum(['equal_groups', 'distributivity', 'fraction_amount', 'fraction_comparison', 'fraction_equivalence', 'number_order', 'number_distance', 'area', 'area_conservation']),
  action: z.enum(['observe', 'calculate', 'compare', 'change', 'conserve', 'question']),
  targets: z.array(z.string().min(1).max(80)).max(2).default([]).describe('Optional visible bar/marker IDs or unambiguous labels A, B, etc. Comparisons need two targets; observations and transformations can select one.'),
}).strict();
export type TeachingIntent = z.input<typeof TeachingIntentSchema>;
type Concept = z.infer<typeof TeachingIntentSchema>['concept'];
export const MATH_CAPABILITIES: Record<Concept, { kinds: MathVisual['kind'][]; quantity: string }> = {
  equal_groups: { kinds: ['array'], quantity: 'number of squares' },
  distributivity: { kinds: ['array'], quantity: 'number of squares' },
  fraction_amount: { kinds: ['bars'], quantity: 'shaded fraction of an equal whole' },
  fraction_comparison: { kinds: ['bars'], quantity: 'shaded fraction of an equal whole' },
  fraction_equivalence: { kinds: ['bars'], quantity: 'shaded fraction of an equal whole' },
  number_order: { kinds: ['number_line'], quantity: 'position' },
  number_distance: { kinds: ['number_line'], quantity: 'distance' },
  area: { kinds: ['geometry', 'parallelogram'], quantity: 'area in square units' },
  area_conservation: { kinds: ['geometry', 'parallelogram'], quantity: 'area in square units' },
};

// Model-authored labels can themselves assert false mathematics ("one half",
// "obtuse triangle"). Keep only neutral identifiers on generated diagrams.
export function canonicalMathVisual(input: MathVisual): MathVisual {
  const v = structuredClone(input);
  v.title = ({ array: 'Equal groups', bars: 'Fractions', geometry: 'Area', parallelogram: 'Area', number_line: 'Number line' })[v.kind];
  if (v.kind === 'bars') v.bars.forEach((b, i) => { b.label = String.fromCharCode(65 + i); });
  if (v.kind === 'number_line') v.markers.forEach((m, i) => { m.label = String.fromCharCode(65 + i); });
  return MathVisualSchema.parse(v);
}

const number = (n: number) => String(Number(n.toFixed(8)));
const fail = (message: string): never => { throw new Error(`Unsupported teaching claim: ${message}`); };
/** Resolve references, never quantities. A visible label is accepted only when
 * it identifies exactly one object, with no conflicting ID match. */
export function resolveMathTarget(v: MathVisual, target: string): string {
  if (v.kind !== 'bars' && v.kind !== 'number_line') return fail('this representation has no addressable targets');
  const items = v.kind === 'bars' ? v.bars : v.markers;
  const matches = items.filter(x => x.id === target || x.label === target);
  if (matches.length !== 1) return fail('distinct visible targets are required; reference is unknown or ambiguous');
  return matches[0].id;
}
function pair(v: MathVisual, targets: string[]) {
  if (v.kind !== 'bars' && v.kind !== 'number_line') return fail('comparison needs fraction bars or number-line markers');
  const items = v.kind === 'bars' ? v.bars : v.markers;
  if (targets.length !== 0 && targets.length !== 2) return fail('a comparison needs exactly two targets');
  const selected = targets.length ? targets.map(id => items.find(item => item.id === id)) : items.slice(0, 2);
  if (selected.length !== 2 || selected.some(x => !x) || selected[0]!.id === selected[1]!.id) return fail('two distinct visible targets are required');
  return selected as [typeof items[number], typeof items[number]];
}
function selectTargets(v: MathVisual, targets: string[]): MathVisual {
  if (!targets.length) return v;
  if (v.kind !== 'bars' && v.kind !== 'number_line') return fail('this representation has no addressable targets');
  const items = v.kind === 'bars' ? v.bars : v.markers;
  if (new Set(targets).size !== targets.length || targets.some(id => !items.some(x => x.id === id))) return fail('distinct visible targets are required');
  return v.kind === 'bars' ? { ...v, bars: targets.map(id => v.bars.find(x => x.id === id)!) }
    : { ...v, markers: targets.map(id => v.markers.find(x => x.id === id)!) };
}
function fraction(n: number, d: number) { return `${n} out of ${d} equal parts`; }
function structure(v: MathVisual): string {
  switch (v.kind) {
    case 'array': return v.splitAt === null
      ? `There are ${v.rows} rows with ${v.columns} squares in each row.`
      : `Each of the ${v.rows} rows is split into ${v.splitAt} and ${v.columns - v.splitAt} squares.`;
    case 'bars': return v.bars.map(b => `Bar ${b.label} has ${b.parts} equal parts, with ${b.shaded} shaded.`).join(' ');
    case 'number_line': return v.markers.map(m => `${m.label} is at ${number(m.value)}.`).join(' ');
    case 'geometry': return `This ${v.shape === 'rectangle' ? 'rectangle' : 'right triangle'} has base ${v.width} and perpendicular height ${v.height}.`;
    case 'parallelogram': return v.stage === 'cut'
      ? 'A perpendicular cut separates the left triangle from the rest of the shape.'
      : v.stage === 'reassembled' ? `The pieces form a rectangle with base ${v.base} and height ${v.height}.`
      : `The base is ${v.base} and the perpendicular height is ${v.height}.`;
  }
}
function comparison(v: MathVisual, targets: string[]): string {
  const [a, b] = pair(v, targets);
  if ('parts' in a && 'parts' in b) {
    const d = a.shaded * b.parts - b.shaded * a.parts;
    return `The wholes are equal in size; bar ${a.label} shows ${fraction(a.shaded, a.parts)}, ${d === 0 ? 'the same amount as' : d < 0 ? 'less than' : 'more than'} bar ${b.label}, with ${fraction(b.shaded, b.parts)}.`;
  }
  if ('value' in a && 'value' in b) return `${a.label} at ${number(a.value)} is ${a.value === b.value ? 'at the same position as' : a.value < b.value ? 'to the left of' : 'to the right of'} ${b.label} at ${number(b.value)}.`;
  return fail('incompatible comparison');
}
function result(v: MathVisual, intent: z.infer<typeof TeachingIntentSchema>): string {
  if (v.kind === 'array') return v.splitAt === null
    ? `${v.rows} rows times ${v.columns} squares makes ${v.rows * v.columns} squares.`
    : `${v.rows} times ${v.splitAt} plus ${v.rows} times ${v.columns - v.splitAt} is ${v.rows * v.splitAt} plus ${v.rows * (v.columns - v.splitAt)}, making ${v.rows * v.columns} squares.`;
  if (v.kind === 'geometry') return `${v.width} times ${v.height}${v.shape === 'right_triangle' ? ', divided by two,' : ''} gives an area of ${number(geometryArea(v))} square units.`;
  if (v.kind === 'parallelogram') return `Base ${v.base} times perpendicular height ${v.height} gives an area of ${number(v.base * v.height)} square units.`;
  if (v.kind === 'bars') return intent.concept === 'fraction_comparison' || intent.concept === 'fraction_equivalence' ? comparison(v, intent.targets) : structure(v);
  if (intent.concept === 'number_distance') {
    const [a, b] = pair(v, intent.targets) as [typeof v.markers[number], typeof v.markers[number]];
    return `The distance from ${a.label} at ${number(a.value)} to ${b.label} at ${number(b.value)} is ${number(Math.abs(a.value - b.value))} units.`;
  }
  return comparison(v, intent.targets);
}
function question(v: MathVisual, intent: z.infer<typeof TeachingIntentSchema>): string {
  if (v.kind === 'array') return v.splitAt === null ? 'How many squares are there altogether?' : 'How could you use the two parts to find the total?';
  if (v.kind === 'geometry' || v.kind === 'parallelogram') return 'How could you use the base and perpendicular height to find the area?';
  if (v.kind === 'bars' && intent.concept === 'fraction_amount') return `What fraction of bar ${v.bars[0].label} is shaded?`;
  const [a, b] = pair(v, intent.targets);
  return v.kind === 'bars' ? `Do bars ${a.label} and ${b.label} show the same shaded amount, or is one greater?`
    : intent.concept === 'number_distance' ? `How far apart are ${a.label} and ${b.label}?` : `Which is farther right, ${a.label} or ${b.label}, or are they at the same position?`;
}
export function mathStateKey(v: MathVisual) {
  const { title: _title, interactive: _interactive, showEquation: _equation, focus: _focus, id: _id, ...math } = v;
  return JSON.stringify(math);
}
function area(v: MathVisual) { return v.kind === 'geometry' ? geometryArea(v) : v.kind === 'parallelogram' ? v.base * v.height : fail('an area claim needs an area diagram'); }
function change(before: MathVisual, after: MathVisual): string {
  if (before.kind === 'parallelogram' && after.kind === 'parallelogram') {
    if (before.stage === 'slant' && after.stage === 'cut') return 'Cut along the perpendicular height to separate the left triangle.';
    if (before.stage === 'cut' && after.stage === 'reassembled') return `The left triangle slides right by ${after.base} units to complete the rectangle.`;
  }
  if (before.kind === 'array' && after.kind === 'array' && before.rows === after.rows && before.columns === after.columns && after.splitAt !== null)
    return `Split each row into ${after.splitAt} and ${after.columns - after.splitAt} squares; there are still ${after.rows} rows of ${after.columns}.`;
  if (before.kind === 'geometry' && after.kind === 'geometry') {
    const changes = (['width', 'height'] as const).filter(key => before[key] !== after[key]);
    return changes.map(key => `The ${key === 'width' ? 'base' : 'perpendicular height'} changes from ${before[key]} to ${after[key]} units.`).join(' ');
  }
  if (before.kind === 'bars' && after.kind === 'bars') return after.bars.filter(a => {
    const b = before.bars.find(x => x.id === a.id);
    return !b || b.parts !== a.parts || b.shaded !== a.shaded;
  }).map(a => {
    const b = before.bars.find(x => x.id === a.id);
    return b ? `Bar ${a.label} changes from ${fraction(b.shaded, b.parts)} to ${fraction(a.shaded, a.parts)}.` : structure(after);
  }).join(' ');
  return `Before: ${structure(before)} Now: ${structure(after)}`;
}
function conserve(before: MathVisual, after: MathVisual, intent: z.infer<typeof TeachingIntentSchema>): string {
  if (before.kind === 'array' && after.kind === 'array') {
    if (before.rows * before.columns !== after.rows * after.columns) return fail('the total number of squares changed');
    return `The arrangement changed, but there are still ${after.rows * after.columns} squares.`;
  }
  if (before.kind === 'bars' && after.kind === 'bars') {
    if (before.bars.length !== after.bars.length) return fail('conservation must keep the same bars');
    for (const a of after.bars) {
      const b = before.bars.find(x => x.id === a.id);
      if (!b || a.shaded * b.parts !== b.shaded * a.parts) return fail('repartitioning changed the shaded fraction');
    }
    return `The partitions changed, but ${after.bars.map(b => `bar ${b.label}`).join(' and ')} ${after.bars.length === 1 ? 'keeps' : 'keep'} the same shaded amount of the same whole.`;
  }
  if (intent.concept === 'area_conservation' || intent.concept === 'area') {
    if (area(before) !== area(after)) return fail('the area changed');
    return `The shape changed, but its area is still ${number(area(after))} square units.`;
  }
  return fail('no conservation evaluator for this representation');
}

/** The sole source of spoken mathematical claims. No model-authored assertion
 * is copied through. This checks the renderer's actual before/after states. */
export function compileTeaching(input: unknown, after: MathVisual, before?: MathVisual): { narration: string; intent: z.infer<typeof TeachingIntentSchema> } {
  const intent = TeachingIntentSchema.parse(input);
  intent.targets = intent.targets.map(target => resolveMathTarget(after, target));
  const capability = MATH_CAPABILITIES[intent.concept];
  if (!capability.kinds.includes(after.kind)) return fail(`${intent.concept} cannot be shown with ${after.kind}`);
  after = selectTargets(after, intent.targets);
  if (before && ['change', 'conserve'].includes(intent.action)) before = selectTargets(before, intent.targets);
  if (intent.concept === 'number_distance' && intent.action === 'compare') return fail('use calculate to measure distance, or number_order to compare positions');
  if (intent.concept === 'distributivity' && intent.action === 'calculate' && after.kind === 'array' && after.splitAt === null) return fail('split the array before deriving its two partial products');
  if (intent.concept === 'fraction_equivalence' && ['compare', 'calculate'].includes(intent.action)) {
    const [a, b] = pair(after, intent.targets);
    if (!('parts' in a) || !('parts' in b) || a.shaded * b.parts !== b.shaded * a.parts) return fail('these fractions are not equivalent');
  }
  let narration: string;
  switch (intent.action) {
    case 'observe': narration = structure(after); break;
    case 'calculate': narration = result(after, intent); break;
    case 'compare': narration = comparison(after, intent.targets); break;
    case 'question': narration = question(after, intent); break;
    case 'change':
    case 'conserve': {
      if (!before || !capability.kinds.includes(before.kind)) return fail('a transformation needs a compatible starting picture');
      if (mathStateKey(before) === mathStateKey(after)) return fail('no mathematical change was rendered');
      if (intent.action === 'conserve') narration = conserve(before, after, intent);
      else narration = change(before, after);
      break;
    }
  }
  return { narration, intent };
}

export const GROUNDED_TEACHING_INSTRUCTIONS = `Every generated moment must include teaching:{concept,action,targets:[]}. Do not write narration: code derives the spoken facts and questions from the rendered quantities. Concepts and compatible pictures: equal_groups/distributivity=array; fraction_amount/fraction_comparison/fraction_equivalence=bars; number_order/number_distance=number_line; area/area_conservation=geometry or parallelogram. These are the only demonstrated capabilities; never substitute an unrelated picture for an unsupported concept. Actions: observe describes the visible structure; calculate computes its result; compare evaluates two visible bars or markers (targets optionally names two IDs); change describes a real before/after change; conserve requires a real change that preserves the measured quantity; question asks one question about the visible quantities. Use observe then update+change/conserve then calculate or question as needed. No filler or minimum duration. A question is final and should hide the equation. Labels are assigned A, B, etc by code. The model chooses examples, numbers and sequence; code owns factual claims and labels.`;
