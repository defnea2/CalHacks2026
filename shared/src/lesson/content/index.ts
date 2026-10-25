// Seed content library (spec "Content library"). One file per concept; categories mirror the
// pack taxonomy so both stay consistent. Replaceable like the rest of the pack.
import type { ContentLibrary } from '../types';
import { taxonomy } from '../pack/taxonomy';
import type { ConceptBundle } from './helpers';
import { placeValue } from './placeValue';
import { multiplicationGroups } from './multiplicationGroups';
import { divisionSharing } from './divisionSharing';
import { fractionsUnit } from './fractionsUnit';
import { fractionsCompare } from './fractionsCompare';
import { fractionsExpand } from './fractionsExpand';
import { fractionsAddSame } from './fractionsAddSame';
import { decimalsTenths } from './decimalsTenths';

export type { ConceptBundle } from './helpers';

export const bundles: ConceptBundle[] = [
  placeValue,
  multiplicationGroups,
  divisionSharing,
  fractionsUnit,
  fractionsCompare,
  fractionsExpand,
  fractionsAddSame,
  decimalsTenths,
];

export const library: ContentLibrary = {
  categories: taxonomy.map((c, i) => ({ key: c.key, title: c.title, position: i + 1 })),
  concepts: bundles.map(b => b.concept),
  skills: bundles.flatMap(b => b.skills),
  explanations: bundles.flatMap(b => b.explanations),
  tasks: bundles.flatMap(b => b.tasks),
};
