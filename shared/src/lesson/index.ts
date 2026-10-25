import type { LessonPack } from './types';
import { phases, initialPhase, finalPhase } from './pack/phases';
import { boardKinds } from './pack/boardKinds';
import { taxonomy } from './pack/taxonomy';
import { prompts } from './pack/prompts';
import { content } from './pack/content';

export * from './types';

/** The active lesson pack. Swap this export to replace all placeholder content. */
export const pack: LessonPack = {
  version: 'placeholder-0.1.0',
  phases,
  initialPhase,
  finalPhase,
  boardKinds,
  taxonomy,
  prompts,
  content,
};
