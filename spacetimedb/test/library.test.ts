import { describe, it, expect } from 'vitest';
import { TestAuth } from 'spacetimedb/server/test-utils';
import { pack } from '../../shared/src/lesson/index';
import { mod, setup } from './helpers';

describe('content library', () => {
  it('init loads the pack content with JSON list fields and reloads when the content changes', () => {
    const saved = structuredClone(pack.content);
    try {
      pack.content.categories = [{ key: 'fractions', title: 'Fractions', position: 1 }];
      pack.content.concepts = [
        { key: 'fractions-expand', category: 'fractions', title: 'Expanding', language: 'en', gradeBand: '5-6', dependsOn: ['fractions-unit'], summary: 'Same amount.' },
      ];
      pack.content.skills = [
        { key: 'fractions-expand/given-factor', concept: 'fractions-expand', position: 1, title: 'Given k', kind: 'compute', steps: [{ show: 'a', say: 'a' }], keyStepIndex: 0, commonMistake: 'top only', tutorNote: '' },
      ];
      pack.content.explanations = [];
      pack.content.tasks = [
        { key: 'fe-gap-1', skill: 'fractions-expand/given-factor', type: 'gap', difficulty: 1, show: '\\square', say: 'x', answer: { form: 'number', value: '3' }, steps: [], wrongStepIndex: -1 },
      ];
      const { h } = setup();
      expect(h.db.concept.key.find('fractions-expand')!.dependsOn).toBe('["fractions-unit"]');
      expect(JSON.parse(h.db.skill.key.find('fractions-expand/given-factor')!.steps)).toEqual([{ show: 'a', say: 'a' }]);
      expect(h.db.task.key.find('fe-gap-1')).toMatchObject({ concept: 'fractions-expand', answer: '{"form":"number","value":"3"}' });
      expect(h.db.libraryMeta.id.find(0)!.packVersion.startsWith(pack.version)).toBe(true);

      pack.content.tasks = [];
      h.withReducerTx(TestAuth.internal(), ctx => (mod.onConnect as any)(ctx, {}));
      expect([...h.db.task.iter()]).toHaveLength(0);
      expect(h.db.concept.key.find('fractions-expand')).toBeTruthy();
    } finally {
      Object.assign(pack.content, saved);
    }
  });
});
