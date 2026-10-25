// Import of richer external topic files into the library shape (spec "Content library",
// "Importing richer content later"). Pure function, no I/O.
//
// Mapping: topic -> concept; knowledge_points -> skills (by position); atoms -> skill.steps;
// is_plutonium -> keyStepIndex; instructional_comments -> commonMistake / tutorNote;
// explanation -> explanation of kind rule; worked_example -> task of type worked_example
// (narration_hint -> say); tasks -> solo tasks (prompt -> show, prompt_natural -> say,
// worked_solution_steps -> steps, expected_intermediate -> expected, diagnostic_prompt -> hint).
// Region metadata, tool context and materials are dropped.
//
// We have no real file of that format, so the input type only names the fields the spec
// names; everything is optional and read defensively (unknown fields are ignored).
import type { LibraryConcept, LibraryExplanation, LibrarySkill, LibraryTask, StepDef, TaskStep } from './types';
import { parseFraction, parseNumber } from '../answers';

type Loose = Record<string, unknown>;
/** Free text, or an object holding text in some field. */
export type ExternalText = string | Loose;

export interface ExternalAtom extends Loose {
  is_plutonium?: boolean;
}
export interface ExternalSolutionStep extends Loose {
  expected_intermediate?: string | number;
  diagnostic_prompt?: string;
  narration_hint?: string;
  prompt?: string;
  prompt_natural?: string;
}
export interface ExternalKnowledgePoint extends Loose {
  position?: number;
  atoms?: (string | ExternalAtom)[];
  instructional_comments?: ExternalText | ExternalText[];
}
export interface ExternalWorkedExample extends Loose {
  prompt?: string;
  prompt_natural?: string;
  narration_hint?: string;
  worked_solution_steps?: (string | ExternalSolutionStep)[];
}
export interface ExternalTask extends Loose {
  prompt?: string;
  prompt_natural?: string;
  worked_solution_steps?: (string | ExternalSolutionStep)[];
}
export interface ExternalTopic extends Loose {
  knowledge_points?: ExternalKnowledgePoint[];
  explanation?: ExternalText;
  worked_example?: ExternalWorkedExample;
  tasks?: ExternalTask[];
}

/** Library identity of the imported concept (the external file's own metadata is not trusted). */
export interface ImportTarget {
  conceptKey: string;
  category: string;
  title?: string;
  language?: string;
  gradeBand?: string;
  dependsOn?: string[];
  summary?: string;
}

export interface ImportResult {
  concept: LibraryConcept;
  skills: LibrarySkill[];
  explanations: LibraryExplanation[];
  tasks: LibraryTask[];
  /** Things that could not be mapped cleanly (missing answers, defaults used). */
  warnings: string[];
}

// ---------------------------------------------------------------------------

const SHOW_KEYS = ['show', 'latex', 'formula', 'prompt', 'step', 'text', 'content', 'statement', 'title'];
const SAY_KEYS = ['say', 'narration_hint', 'prompt_natural', 'spoken', 'natural'];
const ID_KEYS = ['key', 'id', 'slug'];
const TITLE_KEYS = ['title', 'name', 'label'];

const isObj = (x: unknown): x is Loose => typeof x === 'object' && x !== null && !Array.isArray(x);

function str(x: unknown): string | undefined {
  if (typeof x === 'string' && x.trim()) return x.trim();
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  return undefined;
}

function pick(x: unknown, keys: string[]): string | undefined {
  if (typeof x === 'string') return str(x);
  if (!isObj(x)) return undefined;
  for (const k of keys) {
    const v = str(x[k]);
    if (v) return v;
  }
  return undefined;
}

/** Any text in x: preferred keys first, then the first string field. */
function anyText(x: unknown, keys: string[]): string | undefined {
  return pick(x, keys) ?? (isObj(x) ? Object.values(x).map(str).find(Boolean) : undefined);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Rough LaTeX -> words, for a `say` when the source has none. Never leaves symbols behind. */
export function toSpoken(latex: string): string {
  return latex
    .replace(/\\text\{([^}]*)\}/g, '$1')
    .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1 over $2')
    .replace(/\\(cdot|times)/g, ' times ')
    .replace(/\\div/g, ' divided by ')
    .replace(/\\square/g, ' blank ')
    .replace(/\\(neq|ne)\b/g, ' is not ')
    .replace(/\\(leq|le)\b/g, ' is at most ')
    .replace(/\\(geq|ge)\b/g, ' is at least ')
    .replace(/\\lt\b|</g, ' is less than ')
    .replace(/\\gt\b|>/g, ' is more than ')
    .replace(/=/g, ' equals ')
    .replace(/\+/g, ' plus ')
    .replace(/\*/g, ' times ')
    .replace(/(\d)\s*\/\s*(\d)/g, '$1 over $2')
    .replace(/\//g, ' over ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[\\{}^_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Makes source text safe as spoken text (the library forbids symbols in `say`). */
const spoken = (s: string) => toSpoken(s);

function inferAnswer(value: string): LibraryTask['answer'] {
  const v = value.trim();
  if (['<', '>', '='].includes(v)) return { form: 'choice', value: v };
  if (parseFraction(v)) return { form: 'fraction', value: v.replace(/\s+/g, '') };
  if (parseNumber(v) !== null) return { form: 'number', value: v };
  return { form: 'text', value: v };
}

function mapStep(raw: string | ExternalSolutionStep): TaskStep {
  const show = anyText(raw, SHOW_KEYS) ?? '';
  const sayRaw = pick(raw, SAY_KEYS);
  const step: TaskStep = { show, say: spoken(sayRaw ?? show) };
  if (isObj(raw)) {
    const expected = str(raw.expected_intermediate);
    const hint = str(raw.diagnostic_prompt);
    if (expected !== undefined) step.expected = expected;
    if (hint !== undefined) step.hint = spoken(hint);
  }
  return step;
}

function mapAtom(raw: string | ExternalAtom): StepDef {
  const show = anyText(raw, SHOW_KEYS) ?? '';
  return { show, say: spoken(pick(raw, SAY_KEYS) ?? show) };
}

const MISTAKE_TAG = /mistake|misconception|error|wrong|pitfall/i;
const MISTAKE_TEXT = /mistake|wrong|error|forget|forgets|confus|instead of|only the|fehler|verwechsel|vergisst/i;

function splitComments(raw: ExternalKnowledgePoint['instructional_comments']): { mistakes: string[]; notes: string[] } {
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const mistakes: string[] = [];
  const notes: string[] = [];
  for (const c of list) {
    const text = anyText(c, ['text', 'comment', 'content', 'note']);
    if (!text) continue;
    const tag = isObj(c) ? pick(c, ['kind', 'type', 'category', 'tag']) ?? '' : '';
    (MISTAKE_TAG.test(tag) || (!tag && MISTAKE_TEXT.test(text)) ? mistakes : notes).push(text);
  }
  return { mistakes, notes };
}

function difficultyOf(x: Loose): 1 | 2 | 3 {
  const d = Number(x.difficulty ?? x.level);
  return Number.isFinite(d) ? (Math.min(3, Math.max(1, Math.round(d))) as 1 | 2 | 3) : 2;
}

// ---------------------------------------------------------------------------

export function importTopic(topic: ExternalTopic, target: ImportTarget): ImportResult {
  const warnings: string[] = [];
  const C = target.conceptKey;

  const concept: LibraryConcept = {
    key: C,
    category: target.category,
    title: target.title ?? pick(topic, TITLE_KEYS) ?? C,
    language: target.language ?? pick(topic, ['language', 'lang']) ?? 'en',
    gradeBand: target.gradeBand ?? pick(topic, ['grade_band', 'gradeBand', 'grade']) ?? '',
    dependsOn: target.dependsOn ?? [],
    summary: target.summary ?? pick(topic, ['summary', 'description']) ?? '',
  };
  if (!concept.gradeBand) warnings.push('concept: no gradeBand');
  if (!concept.summary) warnings.push('concept: no summary');

  // knowledge_points -> skills, ordered by position
  const kps = (Array.isArray(topic.knowledge_points) ? topic.knowledge_points : [])
    .filter(isObj)
    .map((kp, i) => ({ kp, order: typeof kp.position === 'number' ? kp.position : i + 1, i }))
    .sort((a, b) => a.order - b.order || a.i - b.i);
  const usedKeys = new Set<string>();
  const kpRefs = new Map<string, string>(); // external id / position -> skill key
  const skills: LibrarySkill[] = kps.map(({ kp, order }, idx) => {
    const position = idx + 1;
    const ext = pick(kp, ID_KEYS);
    const title = pick(kp, TITLE_KEYS) ?? `Skill ${position}`;
    let key = `${C}/${slug(ext ?? title) || `kp-${position}`}`;
    if (usedKeys.has(key)) key = `${key}-${position}`;
    usedKeys.add(key);
    if (ext) kpRefs.set(ext, key);
    kpRefs.set(String(order), key);
    const atoms = Array.isArray(kp.atoms) ? kp.atoms : [];
    const steps = atoms.map(mapAtom).filter(s => s.show);
    if (!steps.length) warnings.push(`skill ${key}: no atoms`);
    const plutonium = atoms.findIndex(a => isObj(a) && a.is_plutonium === true);
    const { mistakes, notes } = splitComments(kp.instructional_comments as ExternalKnowledgePoint["instructional_comments"]);
    if (!mistakes.length) warnings.push(`skill ${key}: no common mistake in instructional_comments`);
    const kind = /explain/i.test(pick(kp, ['kind', 'type']) ?? '') ? 'explain' : 'compute';
    return {
      key,
      concept: C,
      position,
      title,
      kind,
      steps: steps.length ? steps : [{ show: title, say: spoken(title) }],
      keyStepIndex: plutonium >= 0 && plutonium < Math.max(steps.length, 1) ? plutonium : 0,
      commonMistake: mistakes.join(' ') || 'Not specified.',
      tutorNote: notes.join(' ') || 'Not specified.',
    };
  });
  if (!skills.length) {
    warnings.push('no knowledge_points: created one default skill');
    skills.push({
      key: `${C}/main`,
      concept: C,
      position: 1,
      title: concept.title,
      kind: 'compute',
      steps: [{ show: concept.title, say: spoken(concept.title) }],
      keyStepIndex: 0,
      commonMistake: 'Not specified.',
      tutorNote: 'Not specified.',
    });
  }
  const skillFor = (x: Loose): string => {
    const ref = pick(x, ['knowledge_point', 'knowledge_point_id', 'knowledge_point_key', 'skill']) ?? str(x.knowledge_point_position);
    return (ref && kpRefs.get(ref)) || skills[0]!.key;
  };

  // explanation -> rule explanation for the whole concept
  const explanations: LibraryExplanation[] = [];
  if (topic.explanation !== undefined) {
    const sayText = anyText(topic.explanation, ['say', 'text', 'content', 'explanation', ...SAY_KEYS]);
    const latex = isObj(topic.explanation) ? pick(topic.explanation, ['latex', 'formula', 'show']) : undefined;
    if (sayText) {
      explanations.push({
        id: `${C}/rule`,
        concept: C,
        skill: '',
        kind: 'rule',
        say: spoken(sayText),
        boardItems: latex ? [{ kind: 'equation', content: { latex } }] : [],
      });
    }
  }

  // worked_example and tasks -> library tasks
  const tasks: LibraryTask[] = [];
  const toTask = (raw: Loose, key: string, type: LibraryTask['type'], sayKeys: string[]): LibraryTask => {
    const show = pick(raw, ['prompt', 'show', 'latex', 'text']) ?? '';
    const steps = (Array.isArray(raw.worked_solution_steps) ? raw.worked_solution_steps : Array.isArray(raw.steps) ? raw.steps : [])
      .filter((s): s is string | ExternalSolutionStep => typeof s === 'string' || isObj(s))
      .map(mapStep)
      .filter(s => s.show);
    const answerRaw = pick(raw, ['answer', 'solution', 'result', 'expected_answer']) ?? steps[steps.length - 1]?.expected;
    if (!show) warnings.push(`task ${key}: no prompt`);
    if (!answerRaw) warnings.push(`task ${key}: no answer`);
    return {
      key,
      skill: skillFor(raw),
      type,
      difficulty: difficultyOf(raw),
      show,
      say: spoken(pick(raw, sayKeys) ?? show),
      answer: inferAnswer(answerRaw ?? ''),
      steps,
      wrongStepIndex: -1,
    };
  };
  if (isObj(topic.worked_example)) tasks.push(toTask(topic.worked_example, `${C}/worked`, 'worked_example', ['narration_hint', 'prompt_natural', 'say']));
  (Array.isArray(topic.tasks) ? topic.tasks : []).filter(isObj).forEach((t, i) => {
    const ext = pick(t, ID_KEYS);
    let key = `${C}/${(ext && slug(ext)) || `task-${i + 1}`}`;
    if (tasks.some(x => x.key === key)) key = `${key}-${i + 1}`;
    tasks.push(toTask(t, key, 'solo', ['prompt_natural', 'say', 'narration_hint']));
  });

  return { concept, skills, explanations, tasks, warnings };
}
