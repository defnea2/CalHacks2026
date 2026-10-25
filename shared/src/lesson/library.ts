// Library index + topic prefetch for the lesson planner (pure; module and worker share it).
//
//   libraryIndex(pack)        -> compact, cache-stable index of the whole library (concepts with a
//                                one-line summary, skills, task keys) for the planner system prompt
//   conceptMaterial(pack, k)  -> the checked material of one concept (skills with steps and common
//                                mistake, explanations, tasks with answers) for the planner data
//   guessTopic(pack, text)    -> the concept a task text points to (keyword cues of the pack), or
//                                only the category, or null (the worker then asks the LLM)
import type { LessonPack } from './types';
import { fractionCue, topicCues } from './pack/topics';

export interface TopicGuess {
  category: string;
  /** '' = only the category is known. */
  concept: string;
  score: number;
}

export function libraryIndex(pack: LessonPack): string {
  const c = pack.content;
  const lines: string[] = [];
  for (const cat of pack.taxonomy) {
    lines.push(`${cat.key}: ${cat.title}`);
    for (const k of cat.concepts) {
      const lib = c.concepts.find(x => x.key === k.key);
      if (!lib) {
        lines.push(`  ${k.key}: ${k.title} (no library material)`);
        continue;
      }
      const skills = c.skills.filter(s => s.concept === k.key).sort((a, b) => a.position - b.position);
      const tasks = c.tasks.filter(t => skills.some(s => s.key === t.skill));
      lines.push(`  ${k.key}: ${lib.title}, grade ${lib.gradeBand}. ${lib.summary}`);
      if (skills.length) lines.push(`    skills: ${skills.map(s => `${s.key.split('/').pop()} (${s.title})`).join('; ')}`);
      if (tasks.length) lines.push(`    tasks: ${[...new Set(tasks.map(t => t.type))].map(type => `${type} ${tasks.filter(t => t.type === type).length}`).join(', ')}`);
    }
  }
  return `LIBRARY INDEX (checked teaching material; the data field library holds the full material of the current concept when it is known):\n${lines.join('\n')}`;
}

/** The checked material of a concept, compact (speech text, no LaTeX/board layouts). */
export function conceptMaterial(pack: LessonPack, concept: string): Record<string, unknown> | null {
  const c = pack.content;
  const lib = c.concepts.find(x => x.key === concept);
  if (!lib) return null;
  const skills = c.skills.filter(s => s.concept === concept).sort((a, b) => a.position - b.position);
  const tasks = c.tasks.filter(t => skills.some(s => s.key === t.skill));
  return {
    concept: lib.key,
    title: lib.title,
    summary: lib.summary,
    dependsOn: lib.dependsOn,
    skills: skills.map(s => ({
      key: s.key,
      title: s.title,
      steps: s.steps.map(st => st.say),
      keyStep: s.keyStepIndex + 1,
      commonMistake: s.commonMistake,
      tutorNote: s.tutorNote,
    })),
    explanations: c.explanations.filter(e => e.concept === concept).map(e => ({ kind: e.kind, say: e.say })),
    tasks: tasks.map(t => ({ key: t.key, type: t.type, difficulty: t.difficulty, say: t.say, answer: t.answer.value })),
  };
}

const re = (src: string) => new RegExp(`(^|[^\\p{L}\\p{N}])(${src})(?=$|[^\\p{L}\\p{N}])`, 'iu');

/** Keyword topic guess. A unique best concept wins; a tie inside fractions gives the category only. */
export function guessTopic(pack: LessonPack, text: string): TopicGuess | null {
  const t = text.toLowerCase();
  if (!t.trim()) return null;
  const fractionish = re(fractionCue).test(t);
  const scores: TopicGuess[] = [];
  for (const cat of pack.taxonomy) {
    for (const k of cat.concepts) {
      const cues = topicCues[k.key] ?? [];
      let score = cues.filter(src => re(src).test(t)).length;
      // Fraction concepts need a fraction in sight ("smaller" alone is not about fractions).
      if (cat.key === 'fractions' && !fractionish) score = 0;
      if (score) scores.push({ category: cat.key, concept: k.key, score });
    }
  }
  scores.sort((a, b) => b.score - a.score);
  const [best, second] = scores;
  if (best && (!second || best.score > second.score)) return best;
  if (best && second && best.category === second.category) return { category: best.category, concept: '', score: best.score };
  const fractions = pack.taxonomy.find(c => c.concepts.some(k => k.key.startsWith('fractions')));
  if (fractionish && fractions) return { category: fractions.key, concept: '', score: 0 };
  return null;
}
