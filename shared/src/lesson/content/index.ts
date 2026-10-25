// Seed content library (spec "Content library"). One file per concept; categories mirror the
// pack taxonomy so both stay consistent. Replaceable like the rest of the pack.
import type { ContentLibrary } from '../types';
import { taxonomy } from '../pack/taxonomy';
import type { ConceptBundle } from './helpers';
import { fractionsExpand } from './fractionsExpand';

export const bundles: ConceptBundle[] = [fractionsExpand];

export const library: ContentLibrary = {
  categories: taxonomy.map((c, i) => ({ key: c.key, title: c.title, position: i + 1 })),
  concepts: bundles.map(b => b.concept),
  skills: bundles.flatMap(b => b.skills),
  explanations: bundles.flatMap(b => b.explanations),
  tasks: bundles.flatMap(b => b.tasks),
};
