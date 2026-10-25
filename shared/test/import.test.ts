import { describe, expect, it } from 'vitest';
import { importTopic, toSpoken, type ExternalTopic } from '../src/lesson/import';
import { pack } from '../src/lesson/index';
import type { LessonPack } from '../src/lesson/types';
import { checkLibraryIntegrity, checkLibraryTexts, checkTaskAnswers } from '../src/lesson/contract';

// Small synthetic topic in the external format (field names from the spec mapping).
const topic: ExternalTopic = {
  title: 'Bruch erweitern',
  region: { country: 'DE', state: 'BY' },
  tool_context: { calculator: false },
  materials: ['worksheet.pdf'],
  explanation: { text: 'Multiply top and bottom by the same number.', latex: '\\frac{a}{b} = \\frac{a \\cdot k}{b \\cdot k}' },
  knowledge_points: [
    {
      id: 'target',
      title: 'To a target denominator',
      position: 2,
      atoms: [{ text: 'k = \\text{target} \\div b', is_plutonium: true }, { text: 'a \\cdot k' }],
      instructional_comments: [{ type: 'mistake', text: 'Divides the wrong way round.' }, 'Let them check k by multiplying back.'],
    },
    {
      id: 'given',
      title: 'By a given factor',
      position: 1,
      atoms: ['\\frac{a}{b} = \\frac{a \\cdot k}{b \\cdot k}', { text: 'a \\cdot k' }, { text: 'b \\cdot k', is_plutonium: true }],
      instructional_comments: ['Common mistake: multiplies only the top.', 'Use the pizza picture.'],
    },
  ],
  worked_example: {
    knowledge_point: 'given',
    prompt: '\\text{Expand } \\frac{3}{5} \\text{ by } 4',
    narration_hint: 'Expand three fifths by four.',
    worked_solution_steps: [
      { text: '3 \\cdot 4 = 12', expected_intermediate: 12, diagnostic_prompt: 'What is three times four?' },
      { text: '\\frac{3}{5} = \\frac{12}{20}', expected_intermediate: '12/20' },
    ],
  },
  tasks: [
    {
      knowledge_point: 'target',
      difficulty: 3,
      prompt: '\\text{Expand } \\frac{2}{5} \\text{ to the denominator } 20',
      prompt_natural: 'Expand two fifths so the bottom is twenty.',
      answer: '8/20',
      worked_solution_steps: [
        { text: '20 \\div 5 = 4', expected_intermediate: '4', diagnostic_prompt: 'How often does 5 fit into 20?' },
        { text: '\\frac{2}{5} = \\frac{8}{20}', expected_intermediate: '8/20' },
      ],
    },
  ],
};

describe('importTopic', () => {
  const r = importTopic(topic, { conceptKey: 'fractions-expand-import', category: 'fractions', gradeBand: '5-6', summary: 'Expand fractions.' });

  it('maps knowledge points to skills by position', () => {
    expect(r.skills.map(s => [s.key, s.position])).toEqual([
      ['fractions-expand-import/given', 1],
      ['fractions-expand-import/target', 2],
    ]);
    expect(r.skills[0]!.steps.map(s => s.show)).toEqual(['\\frac{a}{b} = \\frac{a \\cdot k}{b \\cdot k}', 'a \\cdot k', 'b \\cdot k']);
    expect(r.skills[0]!.keyStepIndex).toBe(2);
    expect(r.skills[1]!.keyStepIndex).toBe(0);
    expect(r.skills[0]!.commonMistake).toMatch(/only the top/);
    expect(r.skills[0]!.tutorNote).toMatch(/pizza/);
    expect(r.skills[1]!.commonMistake).toBe('Divides the wrong way round.');
  });

  it('maps explanation, worked example and tasks', () => {
    expect(r.explanations).toEqual([
      expect.objectContaining({ kind: 'rule', skill: '', boardItems: [{ kind: 'equation', content: { latex: '\\frac{a}{b} = \\frac{a \\cdot k}{b \\cdot k}' } }] }),
    ]);
    const [worked, solo] = r.tasks;
    expect(worked).toMatchObject({ type: 'worked_example', skill: 'fractions-expand-import/given', say: 'Expand three fifths by four.', answer: { form: 'fraction', value: '12/20' } });
    expect(worked!.steps[0]).toMatchObject({ expected: '12', hint: 'What is three times four?' });
    expect(solo).toMatchObject({ type: 'solo', skill: 'fractions-expand-import/target', difficulty: 3, say: 'Expand two fifths so the bottom is twenty.', wrongStepIndex: -1 });
  });

  it('drops region metadata, tool context and materials', () => {
    expect(JSON.stringify(r)).not.toMatch(/BY|calculator|worksheet/);
  });

  it('result passes the pack contract checks when merged into a pack', () => {
    const p: LessonPack = structuredClone(pack);
    p.taxonomy.find(c => c.key === 'fractions')!.concepts.push({ key: r.concept.key, title: r.concept.title });
    p.content.concepts.push(r.concept);
    p.content.skills.push(...r.skills);
    p.content.explanations.push(...r.explanations);
    p.content.tasks.push(...r.tasks);
    expect([...checkLibraryIntegrity(p), ...checkLibraryTexts(p), ...checkTaskAnswers(p)]).toEqual([]);
  });

  it('is defensive about missing fields', () => {
    const empty = importTopic({}, { conceptKey: 'x', category: 'fractions' });
    expect(empty.skills).toHaveLength(1);
    expect(empty.tasks).toEqual([]);
    expect(empty.warnings.length).toBeGreaterThan(0);
  });

  it('toSpoken leaves no symbols', () => {
    expect(toSpoken('\\frac{3}{5} = \\frac{12}{20}')).toBe('3 over 5 equals 12 over 20');
    expect(toSpoken('3 / 4 + 1 < 2')).not.toMatch(/[\\{}=<>/+]/);
  });
});
