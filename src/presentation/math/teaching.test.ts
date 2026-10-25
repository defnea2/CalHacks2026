import { describe, expect, it } from 'vitest';
import { validateVoiceCanvasContent } from '../voice/validate';
import { MathVisualSchema } from './models';
import { compileTeaching, canonicalMathVisual } from './teaching';

const visual = (fields: object) => canonicalMathVisual(MathVisualSchema.parse({ id: 'math', title: 'Untrusted title', ...fields }));
const array = visual({ kind: 'array', rows: 3, columns: 7 });
const plan = (moments: object[]) => ({ title: 'A misleading title', moments: moments.map((m, sentenceOffset) => ({ sentenceOffset, ...m })) });
const strict = (input: unknown) => validateVoiceCanvasContent(input, { requireGrounding: true });
describe('grounded teaching compiler', () => {
  it('derives speech and neutral labels from the same state, ignoring conflicting prose', () => {
    const result = strict(plan([{ visual: { kind: 'array', rows: 3, columns: 7 }, narration: 'There are 99 squares.', teaching: { concept: 'equal_groups', action: 'calculate' } }]));
    expect(result.moments[0].narration).toBe('3 rows times 7 squares makes 21 squares.');
    expect(result.title).toBe('Equal groups');
    const bars = strict(plan([{ visual: { kind: 'bars', bars: [{ id: 'a', label: 'One half', parts: 4, shaded: 1 }] }, teaching: { concept: 'fraction_amount', action: 'observe' } }]));
    expect(bars.moments[0].narration).toBe('Bar A has 4 equal parts, with 1 shaded.');
    expect(JSON.stringify(bars)).not.toContain('One half');
  });
  it('requires grounding for every newly generated moment and rejects unknown capabilities', () => {
    expect(() => strict(plan([{ visual: { kind: 'array', rows: 3, columns: 7 }, narration: 'Three times seven is 99.' }]))).toThrow(/structured teaching intent/);
    expect(() => compileTeaching({ concept: 'angle_classification', action: 'observe' }, visual({ kind: 'geometry', shape: 'right_triangle', width: 3, height: 5 }))).toThrow();
    expect(() => compileTeaching({ concept: 'fraction_comparison', action: 'compare' }, array)).toThrow(/cannot be shown/);
  });
  it('computes fraction comparisons by cross multiplication, including unequal partitions', () => {
    for (let p = 1; p <= 12; p++) for (let q = 1; q <= 12; q++) {
      const a = Math.floor(p / 2), b = Math.ceil(q / 2);
      const v = visual({ kind: 'bars', bars: [{ id: 'a', label: 'X', parts: p, shaded: a }, { id: 'b', label: 'Y', parts: q, shaded: b }] });
      const s = compileTeaching({ concept: 'fraction_comparison', action: 'compare' }, v).narration;
      expect(s).toContain(a * q === b * p ? 'the same amount as' : a * q < b * p ? 'less than' : 'more than');
    }
  });
  it('rejects false conservation across independent representation families', () => {
    expect(() => compileTeaching({ concept: 'equal_groups', action: 'conserve' }, visual({ kind: 'array', rows: 3, columns: 8 }), array)).toThrow(/squares changed/);
    const before = visual({ kind: 'bars', bars: [{ id: 'a', label: 'A', parts: 2, shaded: 1 }] });
    expect(() => compileTeaching({ concept: 'fraction_equivalence', action: 'conserve' }, visual({ kind: 'bars', bars: [{ id: 'a', label: 'A', parts: 4, shaded: 1 }] }), before)).toThrow(/shaded fraction/);
    expect(compileTeaching({ concept: 'fraction_equivalence', action: 'conserve' }, visual({ kind: 'bars', bars: [{ id: 'a', label: 'A', parts: 4, shaded: 2 }] }), before).narration).toContain('same shaded amount');
    expect(() => compileTeaching({ concept: 'area_conservation', action: 'conserve' }, visual({ kind: 'geometry', shape: 'rectangle', width: 3, height: 5 }), visual({ kind: 'geometry', shape: 'rectangle', width: 3, height: 2 }))).toThrow(/area changed/);
  });
  it('requires actual mathematical changes, distinct targets and valid starting states', () => {
    expect(() => compileTeaching({ concept: 'equal_groups', action: 'change' }, array)).toThrow(/starting picture/);
    expect(() => compileTeaching({ concept: 'equal_groups', action: 'conserve' }, { ...array, showEquation: true }, array)).toThrow(/no mathematical change/);
    const line = visual({ kind: 'number_line', min: -5, max: 5, markers: [{ id: 'a', label: 'A', value: -2 }, { id: 'b', label: 'B', value: 3 }] });
    expect(compileTeaching({ concept: 'number_distance', action: 'calculate' }, line).narration).toContain('5 units');
    for (const targets of [['a', 'a'], ['a', 'missing']]) expect(() => compileTeaching({ concept: 'number_order', action: 'compare', targets }, line)).toThrow(/distinct visible targets/);
  });
  it('preflights the entire sequence and never mutates or silently repairs the proposal', () => {
    const proposal = plan([
      { visual: { kind: 'array', rows: 3, columns: 7 }, teaching: { concept: 'equal_groups', action: 'observe' } },
      { visual: { kind: 'update', changes: [{ type: 'set_array', columns: 8 }] }, teaching: { concept: 'equal_groups', action: 'conserve' } },
    ]);
    const original = JSON.stringify(proposal);
    expect(() => strict(proposal)).toThrow(/squares changed/);
    expect(JSON.stringify(proposal)).toBe(original);
    expect(() => strict(plan([{ visual: { kind: 'bars', bars: [{ id: 'a', label: 'A', parts: 2, shaded: 3 }] }, teaching: { concept: 'fraction_amount', action: 'observe' } }]))).toThrow(/Shading exceeds/);
  });
});
