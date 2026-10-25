// Contract tests for the lesson pack. They only use the LessonPack interface, so any
// merged-in pack must pass them unchanged (swap the `pack` import to test another one).
import { describe, expect, it } from 'vitest';
import { pack } from '../src/lesson/index';
import type { LessonPack, LibraryTask, JsonSchema } from '../src/lesson/types';
import {
  ALLOWED_PLACEHOLDERS,
  PACK_CHECKS,
  boardKindNames,
  checkPack,
  checkTaskAnswer,
  missingRenderers,
} from '../src/lesson/contract';
import { evaluateChain, fillBlank } from '../src/lesson/latexMath';
import { buildToolSpecs, canTransition, renderPhaseBlock, renderTemplate } from '../src/lesson/api';

const clone = (p: LessonPack): LessonPack => structuredClone(p);

describe('lesson pack contract (active pack)', () => {
  for (const [name, check] of Object.entries(PACK_CHECKS)) {
    it(`${name}: no violations`, () => {
      expect(check(pack)).toEqual([]);
    });
  }

  it('initial phase can move forward and nothing follows the final phase', () => {
    expect(pack.phases.some(p => p.id !== pack.initialPhase && canTransition(pack, pack.initialPhase, p.id))).toBe(true);
    for (const p of pack.phases) if (p.id !== pack.finalPhase) expect(canTransition(pack, pack.finalPhase, p.id)).toBe(false);
  });

  it('prompts render fully with every allowed placeholder', () => {
    const values = Object.fromEntries(ALLOWED_PLACEHOLDERS.map(p => [p, 'X']));
    for (const t of Object.values(pack.prompts)) expect(renderTemplate(t, values)).not.toMatch(/\{\{\w+\}\}/);
  });

  it('every phase has its own non-empty instructions block', () => {
    for (const p of pack.phases) expect(p.instructions.trim().length, p.id).toBeGreaterThan(20);
    expect(new Set(pack.phases.map(p => p.instructions)).size).toBe(pack.phases.length);
    expect(ALLOWED_PLACEHOLDERS).toContain('phaseInstructions');
  });

  it('system prompt: only the first sentence is short, every reply ends with a next step', () => {
    const sys = pack.prompts.system;
    expect(sys).toMatch(/FIRST sentence/);
    expect(sys).toMatch(/next step/i);
    // No other length limits for the rest of the reply.
    expect(sys).not.toMatch(/12 to 15 words|1 to 3 sentences|Short sentences/);
  });

  it('exports the board kind list for the client renderer registry', () => {
    expect(boardKindNames(pack)).toEqual(pack.boardKinds.map(k => k.name));
    expect(missingRenderers(pack, boardKindNames(pack))).toEqual([]);
    expect(missingRenderers(pack, [])).toEqual(boardKindNames(pack));
  });

  it('buildToolSpecs produces JSON-serializable schemas', () => {
    const specs = buildToolSpecs(pack);
    expect(JSON.parse(JSON.stringify(specs))).toEqual(specs);
  });

  it('every library task is checked (sanity: the library is not empty for the seed pack)', () => {
    expect(pack.content.tasks.length).toBeGreaterThan(0);
    expect(checkPack(pack)).toEqual([]);
  });
});

// The checks must actually catch broken packs, otherwise a green run means nothing.
describe('contract checks catch broken packs', () => {
  const firstTask = (p: LessonPack, pred: (t: LibraryTask) => boolean) => p.content.tasks.find(pred)!;

  it('duplicate phase ids, dangling transitions, final phase with next', () => {
    const p = clone(pack);
    p.phases.push({ ...p.phases[0]! });
    p.phases[1]!.next.push('nowhere');
    p.phases.find(x => x.id === p.finalPhase)!.next.push(p.initialPhase);
    const errs = PACK_CHECKS.phases(p).join('\n');
    expect(errs).toMatch(/duplicate phase id/);
    expect(errs).toMatch(/"nowhere" is not a phase/);
    expect(errs).toMatch(/must have no next phases/);
  });

  it('unreachable final phase and unknown initial phase', () => {
    const p = clone(pack);
    for (const ph of p.phases) ph.next = ph.next.filter(n => n !== p.finalPhase);
    expect(PACK_CHECKS.phases(p).join('\n')).toMatch(/not reachable/);
    p.initialPhase = 'nope';
    expect(PACK_CHECKS.phases(p).join('\n')).toMatch(/initialPhase "nope"/);
  });

  it('board kind without schema', () => {
    const p = clone(pack);
    (p.boardKinds[0] as { contentSchema?: unknown }).contentSchema = undefined;
    expect(PACK_CHECKS.boardKinds(p).join('\n')).toMatch(/missing content schema/);
  });

  it('phase without instructions', () => {
    const p = clone(pack);
    p.phases[2]!.instructions = '  ';
    (p.phases[3] as { instructions?: string }).instructions = undefined;
    const errs = PACK_CHECKS.phases(p).join('\n');
    expect(errs).toMatch(new RegExp(`phase "${p.phases[2]!.id}": instructions must be non-empty`));
    expect(errs).toMatch(new RegExp(`phase "${p.phases[3]!.id}": instructions must be non-empty`));
  });

  it('phase block without {{phaseInstructions}}, phase placeholder in the system prompt, missing opening', () => {
    const p = clone(pack);
    p.prompts.phase = p.prompts.phase.replace('{{phaseInstructions}}', '');
    p.prompts.system += '\n{{phaseInstructions}}';
    delete (p.prompts as { opening?: string }).opening;
    const errs = PACK_CHECKS.prompts(p).join('\n');
    expect(errs).toMatch(/prompt "phase" must contain \{\{phaseInstructions\}\}/);
    expect(errs).toMatch(/"system" must not contain \{\{phaseInstructions\}\}/);
    expect(errs).toMatch(/prompt "opening" is missing/);
  });

  it('renderPhaseBlock contains exactly one phase\'s instructions', () => {
    for (const ph of pack.phases) {
      for (const changed of [false, true]) {
        const b = renderPhaseBlock(pack, ph.id, changed);
        expect(b).toContain(ph.instructions);
        expect(b).not.toMatch(/\{\{\w+\}\}/);
        for (const o of pack.phases) if (o.id !== ph.id) expect(b).not.toContain(o.instructions);
      }
    }
    expect(renderPhaseBlock(pack, pack.phases[1]!.id, true)).toMatch(/replace/);
  });

  it('unknown prompt placeholder', () => {
    const p = clone(pack);
    p.prompts.system += '\n{{secret}}';
    expect(PACK_CHECKS.prompts(p).join('\n')).toMatch(/\{\{secret\}\} is not allowed/);
  });

  it('more than 10 categories and duplicate concept keys', () => {
    const p = clone(pack);
    for (let i = 0; i < 11; i++) p.taxonomy.push({ key: `extra-${i}`, title: 'Extra', concepts: [{ key: 'place-value', title: 'dup' }] });
    const errs = PACK_CHECKS.taxonomy(p).join('\n');
    expect(errs).toMatch(/max 10/);
    expect(errs).toMatch(/duplicate concept/);
  });

  it('broken library references and index ranges', () => {
    const p = clone(pack);
    p.content.concepts[0]!.dependsOn.push('ghost');
    p.content.skills[0]!.keyStepIndex = 99;
    p.content.explanations[0]!.skill = 'ghost/skill';
    p.content.tasks[0]!.skill = 'ghost/skill';
    firstTask(p, t => t.type === 'repair').wrongStepIndex = -1;
    firstTask(p, t => t.type === 'solo').wrongStepIndex = 0;
    const errs = PACK_CHECKS.libraryIntegrity(p).join('\n');
    for (const re of [/dependsOn "ghost"/, /keyStepIndex 99/, /explanation .*skill "ghost\/skill"/, /task .*skill "ghost\/skill"/, /repair wrongStepIndex -1/, /must be -1/])
      expect(errs).toMatch(re);
  });

  it('invalid explanation board item content', () => {
    const p = clone(pack);
    const e = p.content.explanations.find(x => x.boardItems.length)!;
    e.boardItems[0] = { kind: e.boardItems[0]!.kind, content: { bogus: 1 } };
    e.boardItems.push({ kind: 'no_such_kind', content: {} });
    const errs = PACK_CHECKS.explanationBoardItems(p).join('\n');
    expect(errs).toMatch(/is required/);
    expect(errs).toMatch(/unknown board kind "no_such_kind"/);
  });

  it('LaTeX in spoken text', () => {
    const p = clone(pack);
    p.content.tasks[0]!.say = 'Expand \\frac{3}{5} by 4';
    expect(PACK_CHECKS.libraryTexts(p).join('\n')).toMatch(/say contains symbols/);
  });

  it('wrong answers, wrong steps and fake repair steps', () => {
    const base: LibraryTask = {
      key: 't',
      skill: 's',
      type: 'solo',
      difficulty: 1,
      show: '\\text{Expand } \\frac{3}{5} \\text{ by } 4',
      say: 'Expand three fifths by four.',
      answer: { form: 'fraction', value: '12/20' },
      steps: [{ show: '\\frac{3}{5} = \\frac{12}{20}', say: 'ok', expected: '12/20' }],
      wrongStepIndex: -1,
    };
    expect(checkTaskAnswer(base)).toEqual([]);
    // Expanding only the top is not the same amount.
    expect(checkTaskAnswer({ ...base, answer: { form: 'fraction', value: '12/5' } }).join('\n')).toMatch(/does not match|differs/);
    expect(checkTaskAnswer({ ...base, steps: [{ show: '\\frac{3}{5} = \\frac{12}{5}', say: 'x' }] }).join('\n')).toMatch(/does not hold/);
    // Equal value but a different written form is not accepted (3/5 is not 12/20 here).
    expect(checkTaskAnswer({ ...base, answer: { form: 'fraction', value: '6/10' } }).join('\n')).toMatch(/does not match|differs/);
    // No checkable step at all.
    expect(checkTaskAnswer({ ...base, steps: [{ show: '\\text{think}', say: 'x' }] }).join('\n')).toMatch(/no checkable step/);
    // Repair: the wrong step must really be wrong and fixed by `expected`.
    const repair: LibraryTask = { ...base, type: 'repair', wrongStepIndex: 0, steps: [{ show: '\\frac{3}{5} = \\frac{12}{5}', say: 'x', expected: '12/20' }] };
    expect(checkTaskAnswer(repair)).toEqual([]);
    expect(checkTaskAnswer({ ...repair, steps: [{ show: '\\frac{3}{5} = \\frac{12}{20}', say: 'x', expected: '12/20' }] }).join('\n')).toMatch(/actually correct/);
    expect(checkTaskAnswer({ ...repair, steps: [{ show: '\\frac{3}{5} = \\frac{12}{5}', say: 'x', expected: '13/20' }] }).join('\n')).toMatch(/still wrong/);
  });

  it('gap answers must solve the blank, and only the answer does', () => {
    const gap: LibraryTask = {
      key: 'g',
      skill: 's',
      type: 'gap',
      difficulty: 1,
      show: '\\frac{1}{2} = \\frac{\\square}{6}',
      say: 'One half is how many sixths?',
      answer: { form: 'number', value: '3' },
      steps: [],
      wrongStepIndex: -1,
    };
    expect(checkTaskAnswer(gap)).toEqual([]);
    expect(checkTaskAnswer({ ...gap, answer: { form: 'number', value: '2' } }).join('\n')).toMatch(/does not solve/);
    expect(checkTaskAnswer({ ...gap, show: '\\square \\cdot 0 = 0' , answer: { form: 'number', value: '5' } }).join('\n')).toMatch(/ambiguous/);
    expect(checkTaskAnswer({ ...gap, show: '\\frac{1}{4} \\square \\frac{1}{3}', answer: { form: 'choice', value: '<' } })).toEqual([]);
    expect(checkTaskAnswer({ ...gap, show: '\\frac{1}{4} \\square \\frac{1}{3}', answer: { form: 'choice', value: '>' } }).join('\n')).toMatch(/does not solve/);
  });

  it('tool specs follow the pack', () => {
    const p = clone(pack);
    p.phases.push({ id: 'extra_phase', label: 'Extra', description: 'x', instructions: 'Do x.', next: [p.finalPhase] });
    expect(buildToolSpecs(p).find(s => s.name === 'set_phase')!.parameters).toMatchObject({
      properties: { phase: { enum: expect.arrayContaining(['extra_phase']) } },
    });
    expect(PACK_CHECKS.toolSpecs(p)).toEqual([]);
  });

  it('offers the generation contract without dropping historical renderer kinds', () => {
    const verified = pack.boardKinds.filter(k => k.generationSchema);
    expect(verified.length).toBeGreaterThan(0);
    const spec = buildToolSpecs(pack).find(s => s.name === 'show_board_item')!.parameters as JsonSchema;
    expect(spec.properties?.kind?.enum).toEqual(verified.map(k => k.name));
    expect(spec.properties?.content?.anyOf).toEqual(verified.map(k => k.generationSchema));
    expect(pack.boardKinds.length).toBeGreaterThan(verified.length);
  });
});

describe('latexMath evaluator', () => {
  it('evaluates relation chains exactly', () => {
    expect(evaluateChain('\\frac{3}{5} = \\frac{3 \\cdot 4}{5 \\cdot 4} = \\frac{12}{20}')?.holds).toBe(true);
    expect(evaluateChain('\\frac{2}{3} = \\frac{8}{3}')?.holds).toBe(false);
    expect(evaluateChain('0.25 < 0.3')?.holds).toBe(true);
    expect(evaluateChain('0{,}5 = \\frac{1}{2}')?.holds).toBe(true);
    expect(evaluateChain('14 = 4 \\cdot 3 + 2')?.holds).toBe(true);
    expect(evaluateChain('12 \\div 3 = 4 \\neq 5')?.holds).toBe(true);
    expect(evaluateChain('\\left(2 + 3\\right) \\times 2 = 10')?.holds).toBe(true);
    expect(evaluateChain('\\frac{1}{4} \\lt \\frac{1}{3}')?.holds).toBe(true);
  });

  it('returns null for anything it cannot check', () => {
    for (const s of ['\\frac{a}{b}', 'k = 4', '\\text{Expand}', '3 \\text{ cm}', '\\frac{\\square}{6}', '', '2 + ', '2(3)'])
      expect(evaluateChain(s)).toBeNull();
  });

  it('fills a single blank', () => {
    expect(fillBlank('\\frac{1}{2} = \\frac{\\square}{6}', '3')).toContain('{3}');
    expect(evaluateChain(fillBlank('\\frac{1}{2} = \\square', '3/6')!)?.holds).toBe(true);
    expect(fillBlank('\\square + \\square = 2', '1')).toBeNull();
  });
});
