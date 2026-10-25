// Dev/test fixture in the `learnerInsights` contract shape (shared/src/insights.ts). Used by the
// unit tests and, behind `?insightsFixture`, by the profile panel when no procedure is reachable.
import type { LearnerInsights } from '@tutor/shared';

const H = 3_600_000;
const D = 24 * H;

export function insightsFixture(now = Date.now(), learnerId = '1'): LearnerInsights {
  const s1 = '101';
  const s2 = '102';
  const s3 = '103';
  return {
    ok: true,
    learner: {
      id: learnerId,
      name: 'Mia Hoffmann',
      age: 9,
      grade: 4,
      style: 'pictures first, short hints',
      isSimulated: true,
      persona: 'Cheerful and quick, answers before thinking it through. Loves pizza and drawing.',
      sessionCount: 3,
      firstSeenMs: now - 9 * D,
      lastSeenMs: now - 2 * H,
    },
    notes: [
      { id: 'n1', kind: 'misconception', category: 'fractions', concept: 'fractions-add-same', conceptTitle: 'Adding fractions with the same denominator', text: 'Added numerators and denominators: 1/4 + 2/4 = 3/8.', outcome: 'unknown', confidence: 0.92, reinforced: 2, createdMs: now - 9 * D, updatedMs: now - 2 * H, seeded: false, evidence: [{ sessionId: s3, fromTurn: 4, toTurn: 6, quote: 'one quarter plus two quarters is three eighths' }] },
      { id: 'n2', kind: 'misconception', category: 'fractions', concept: 'fractions-compare', conceptTitle: 'Comparing fractions', text: 'Thinks a bigger denominator means a bigger fraction.', outcome: 'unknown', confidence: 0.75, reinforced: 0, createdMs: now - 9 * D, updatedMs: now - 9 * D, seeded: true, evidence: [] },
      { id: 'n3', kind: 'strategy', category: 'fractions', concept: 'fractions-unit', conceptTitle: 'What a fraction is', text: 'Pizza slices made the meaning of the denominator click.', outcome: 'worked', confidence: 0.9, reinforced: 1, createdMs: now - 9 * D, updatedMs: now - 3 * D, seeded: false, evidence: [{ sessionId: s2, fromTurn: 8, toTurn: 9, quote: 'oh so the pizza has 4 slices!!' }] },
      { id: 'n4', kind: 'strategy', category: 'fractions', concept: 'fractions-add-same', conceptTitle: 'Adding fractions with the same denominator', text: 'A long written rule about keeping the denominator lost her attention.', outcome: 'didnt', confidence: 0.8, reinforced: 0, createdMs: now - 2 * H, updatedMs: now - 2 * H, seeded: false, evidence: [{ sessionId: s3, fromTurn: 10, toTurn: 11, quote: 'too many words' }] },
      { id: 'n5', kind: 'mnemonic', category: 'fractions', concept: 'fractions-unit', conceptTitle: 'What a fraction is', text: '"Bottom is the box of slices, top is what you take."', outcome: 'worked', confidence: 0.82, reinforced: 0, createdMs: now - 3 * D, updatedMs: now - 3 * D, seeded: false, evidence: [] },
      { id: 'n6', kind: 'quote', category: 'fractions', concept: 'fractions-unit', conceptTitle: 'What a fraction is', text: '"so the bottom is how many slices the pizza has"', outcome: 'worked', confidence: 0.95, reinforced: 0, createdMs: now - 9 * D, updatedMs: now - 9 * D, seeded: true, evidence: [] },
      { id: 'n7', kind: 'understood', category: 'fractions', concept: 'fractions-unit', conceptTitle: 'What a fraction is', text: 'Explains that the denominator counts equal parts of the whole.', outcome: 'worked', confidence: 0.88, reinforced: 1, createdMs: now - 3 * D, updatedMs: now - 2 * H, seeded: false, evidence: [{ sessionId: s3, fromTurn: 2, toTurn: 3, quote: 'the 4 means the pizza is cut in 4 same pieces' }] },
      { id: 'n8', kind: 'preference', category: 'fractions', concept: '', conceptTitle: '', text: 'Wants a picture before any numbers.', outcome: 'worked', confidence: 0.86, reinforced: 2, createdMs: now - 9 * D, updatedMs: now - 2 * H, seeded: true, evidence: [] },
    ],
    mastery: [
      { concept: 'fractions-unit', title: 'What a fraction is', category: 'fractions', categoryTitle: 'Fractions', mastery: 72, updatedMs: now - 2 * H },
      { concept: 'fractions-add-same', title: 'Adding fractions with the same denominator', category: 'fractions', categoryTitle: 'Fractions', mastery: 25, updatedMs: now - 2 * H },
      { concept: 'fractions-compare', title: 'Comparing fractions', category: 'fractions', categoryTitle: 'Fractions', mastery: 40, updatedMs: now - 3 * D },
      { concept: 'multiplication-groups', title: 'Multiplication as equal groups', category: 'multiply-divide', categoryTitle: 'Multiplying and dividing', mastery: 90, updatedMs: now - 9 * D },
    ],
    summaries: [
      { sessionId: s3, summary: 'Mia explained what the denominator means using pizza slices, then added 1/4 + 2/4 as 3/8 twice before getting 3/4 with a picture.', nextFocus: 'Adding fractions with the same denominator: start from a picture, keep the bottom number fixed.', createdMs: now - 2 * H, taskText: 'What is 1/4 + 2/4?', topic: 'fractions-add-same', topicTitle: 'Adding fractions with the same denominator' },
      { sessionId: s2, summary: 'Worked through what a fraction is with pizzas; by the end Mia named the parts correctly without help.', nextFocus: 'Try adding two fractions with the same denominator.', createdMs: now - 3 * D, taskText: 'What does the 4 in 3/4 mean?', topic: 'fractions-unit', topicTitle: 'What a fraction is' },
      { sessionId: s1, summary: 'Quick multiplication warm-up: Mia solved 4 × 3 with equal groups and drew the groups herself.', nextFocus: '', createdMs: now - 9 * D, taskText: '4 bags with 3 apples each', topic: 'multiplication-groups', topicTitle: 'Multiplication as equal groups' },
    ],
    generatedMs: now,
  };
}

/** A learner with no sessions and no memory yet (empty states). */
export function emptyInsightsFixture(now = Date.now(), learnerId = '2'): LearnerInsights {
  return {
    ok: true,
    learner: { id: learnerId, name: 'Ava Chen', age: 9, grade: 4, style: 'pictures first, short hints', isSimulated: false, persona: '', sessionCount: 0, firstSeenMs: now - D, lastSeenMs: now - D },
    notes: [],
    mastery: [],
    summaries: [],
    generatedMs: now,
  };
}
