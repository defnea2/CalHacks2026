// Lesson pack contract checks. Each check takes ANY LessonPack and returns a list of
// human-readable violations ([] = ok). Used by shared/test/pack.contract.test.ts; the
// module may also call checkPack() at init, and the client stream uses missingRenderers().
import type { JsonSchema, LessonPack, LibraryTask, TaskStep } from './types';
import { buildToolSpecs, renderTemplate, templatePlaceholders, validateJson, TOOL_NAMES } from './api';
import { checkAnswer, parseFraction, parseNumber } from '../answers';
import { evaluateChain, fillBlank, answerToLatex, literalFraction, rat, ratEquals, decimalToRational, BLANK, REL_SPLIT, type Chain, type Rational } from './latexMath';

/** The only placeholders a pack's prompt templates may use (spec "Replaceable lesson pack"). */
export const ALLOWED_PLACEHOLDERS = ['learner', 'memory', 'task', 'phase', 'phases', 'phaseInstructions', 'board', 'tools', 'concepts'] as const;

export const MAX_CATEGORIES = 10;

const TASK_TYPES = ['worked_example', 'repair', 'gap', 'solo', 'follow_up'];
const ANSWER_FORMS = ['number', 'fraction', 'choice', 'text'];
const EXPLANATION_KINDS = ['intuition', 'rule', 'misconception'];
const SKILL_KINDS = ['compute', 'explain'];
const RELATIONS = ['<', '>', '='];

/** Characters that must never appear in spoken (`say`) text: LaTeX and math symbols. */
const SAY_FORBIDDEN = /[\\{}^_=<>/*+]/;

function dupes(xs: string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const x of xs) (seen.has(x) ? out : seen).add(x);
  return [...out];
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export function checkPhases(pack: LessonPack): string[] {
  const errs: string[] = [];
  const ids = pack.phases.map(p => p.id);
  const idSet = new Set(ids);
  if (!ids.length) errs.push('pack has no phases');
  for (const d of dupes(ids)) errs.push(`duplicate phase id "${d}"`);
  for (const p of pack.phases) {
    if (!p.id.trim() || !p.label.trim() || !p.description.trim()) errs.push(`phase "${p.id}": id, label and description must be non-empty`);
    if (typeof p.instructions !== 'string' || !p.instructions.trim()) errs.push(`phase "${p.id}": instructions must be non-empty`);
    for (const n of p.next) if (!idSet.has(n)) errs.push(`phase "${p.id}": next "${n}" is not a phase`);
  }
  if (!idSet.has(pack.initialPhase)) errs.push(`initialPhase "${pack.initialPhase}" is not a phase`);
  const final = pack.phases.find(p => p.id === pack.finalPhase);
  if (!final) errs.push(`finalPhase "${pack.finalPhase}" is not a phase`);
  else if (final.next.length) errs.push(`finalPhase "${pack.finalPhase}" must have no next phases`);
  if (errs.length) return errs;

  const next = new Map(pack.phases.map(p => [p.id, p.next]));
  const reach = (from: string) => {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length) for (const n of next.get(queue.shift()!) ?? []) if (!seen.has(n)) (seen.add(n), queue.push(n));
    return seen;
  };
  const fromInitial = reach(pack.initialPhase);
  for (const id of ids) {
    if (!fromInitial.has(id)) errs.push(`phase "${id}" is not reachable from initialPhase "${pack.initialPhase}"`);
    if (!reach(id).has(pack.finalPhase)) errs.push(`finalPhase "${pack.finalPhase}" is not reachable from phase "${id}"`);
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Board kinds
// ---------------------------------------------------------------------------

/** Board kind names of a pack: the list the client renderer registry must cover. */
export function boardKindNames(pack: LessonPack): string[] {
  return pack.boardKinds.map(k => k.name);
}

/** Kinds without a renderer. Client contract test: expect(missingRenderers(pack, Object.keys(registry))).toEqual([]). */
export function missingRenderers(pack: LessonPack, rendererNames: Iterable<string>): string[] {
  const have = new Set(rendererNames);
  return boardKindNames(pack).filter(k => !have.has(k));
}

function checkSchemaShape(schema: JsonSchema, path: string): string[] {
  const errs: string[] = [];
  if (schema.type === 'object') {
    for (const r of schema.required ?? []) if (!schema.properties?.[r]) errs.push(`${path}: required "${r}" has no property schema`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) errs.push(...checkSchemaShape(sub, `${path}.${k}`));
  }
  if (schema.type === 'array' && schema.items) errs.push(...checkSchemaShape(schema.items, `${path}[]`));
  if (schema.enum && schema.enum.length === 0) errs.push(`${path}: empty enum`);
  if (schema.enum) for (const d of dupes(schema.enum.map(String))) errs.push(`${path}: duplicate enum value "${d}"`);
  for (const [i, s] of (schema.oneOf ?? []).entries()) errs.push(...checkSchemaShape(s, `${path}|${i}`));
  return errs;
}

export function checkBoardKinds(pack: LessonPack): string[] {
  const errs: string[] = [];
  if (!pack.boardKinds.length) errs.push('pack has no board kinds');
  for (const d of dupes(boardKindNames(pack))) errs.push(`duplicate board kind "${d}"`);
  for (const k of pack.boardKinds) {
    if (!k.name.trim() || !k.description.trim()) errs.push(`board kind "${k.name}": name and description must be non-empty`);
    if (!k.contentSchema) errs.push(`board kind "${k.name}": missing content schema`);
    else if (k.contentSchema.type !== 'object' || !k.contentSchema.properties) errs.push(`board kind "${k.name}": content schema must be an object schema with properties`);
    else errs.push(...checkSchemaShape(k.contentSchema, `board kind "${k.name}"`));
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const REQUIRED_PROMPTS = ['system', 'opening', 'context', 'extraction', 'summary'] as const;

export function checkPrompts(pack: LessonPack): string[] {
  const errs: string[] = [];
  const allowed = new Set<string>(ALLOWED_PLACEHOLDERS);
  const values = Object.fromEntries(ALLOWED_PLACEHOLDERS.map(p => [p, `<${p}>`]));
  for (const key of REQUIRED_PROMPTS) if (typeof pack.prompts[key] !== 'string') errs.push(`prompt "${key}" is missing`);
  // Without it the per-phase instructions would never reach the model.
  if (typeof pack.prompts.system === 'string' && !templatePlaceholders(pack.prompts.system).includes('phaseInstructions')) {
    errs.push('prompt "system" must contain {{phaseInstructions}}');
  }
  for (const [name, template] of Object.entries(pack.prompts)) {
    if (typeof template !== 'string' || !template.trim()) {
      errs.push(`prompt "${name}" is empty`);
      continue;
    }
    for (const ph of templatePlaceholders(template)) if (!allowed.has(ph)) errs.push(`prompt "${name}": placeholder {{${ph}}} is not allowed`);
    const rendered = renderTemplate(template, values);
    if (/\{\{|\}\}/.test(rendered)) errs.push(`prompt "${name}": unresolved or malformed placeholder after rendering`);
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

export function checkTaxonomy(pack: LessonPack): string[] {
  const errs: string[] = [];
  const cats = pack.taxonomy.map(c => c.key);
  if (!cats.length) errs.push('taxonomy has no categories');
  if (cats.length > MAX_CATEGORIES) errs.push(`taxonomy has ${cats.length} categories (max ${MAX_CATEGORIES})`);
  for (const d of dupes(cats)) errs.push(`duplicate category "${d}"`);
  const concepts = pack.taxonomy.flatMap(c => c.concepts.map(k => k.key));
  for (const d of dupes(concepts)) errs.push(`duplicate concept "${d}" (concept keys must be unique across categories)`);
  for (const c of cats) if (concepts.includes(c)) errs.push(`"${c}" is both a category and a concept`);
  for (const c of pack.taxonomy) {
    if (!c.key.trim() || !c.title.trim()) errs.push(`category "${c.key}": key and title must be non-empty`);
    for (const k of c.concepts) if (!k.key.trim() || !k.title.trim()) errs.push(`concept "${k.key}": key and title must be non-empty`);
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Content library: referential integrity, ranges, texts
// ---------------------------------------------------------------------------

export function checkLibraryIntegrity(pack: LessonPack): string[] {
  const errs: string[] = [];
  const lib = pack.content;
  const taxCats = new Set(pack.taxonomy.map(c => c.key));
  const taxConceptCat = new Map(pack.taxonomy.flatMap(c => c.concepts.map(k => [k.key, c.key] as const)));

  for (const [what, keys] of [
    ['category', lib.categories.map(c => c.key)],
    ['concept', lib.concepts.map(c => c.key)],
    ['skill', lib.skills.map(s => s.key)],
    ['explanation', lib.explanations.map(e => e.id)],
    ['task', lib.tasks.map(t => t.key)],
  ] as const) for (const d of dupes([...keys])) errs.push(`duplicate ${what} key "${d}"`);

  if (lib.categories.length > MAX_CATEGORIES) errs.push(`library has ${lib.categories.length} categories (max ${MAX_CATEGORIES})`);
  const libCats = new Set(lib.categories.map(c => c.key));
  for (const c of libCats) if (!taxCats.has(c)) errs.push(`library category "${c}" is not in the taxonomy`);
  if (libCats.size) for (const c of taxCats) if (!libCats.has(c)) errs.push(`taxonomy category "${c}" has no library category row`);

  const conceptKeys = new Set(lib.concepts.map(c => c.key));
  for (const c of lib.concepts) {
    if (!libCats.has(c.category)) errs.push(`concept "${c.key}": category "${c.category}" is not a library category`);
    const taxCat = taxConceptCat.get(c.key);
    if (!taxCat) errs.push(`concept "${c.key}" is not in the taxonomy`);
    else if (taxCat !== c.category) errs.push(`concept "${c.key}": category "${c.category}" differs from taxonomy "${taxCat}"`);
    for (const dep of c.dependsOn) {
      if (!conceptKeys.has(dep)) errs.push(`concept "${c.key}": dependsOn "${dep}" is not a library concept`);
      if (dep === c.key) errs.push(`concept "${c.key}" depends on itself`);
    }
    for (const f of ['title', 'language', 'gradeBand', 'summary'] as const) if (!c[f]?.trim()) errs.push(`concept "${c.key}": ${f} is empty`);
  }
  // dependsOn cycles
  const deps = new Map(lib.concepts.map(c => [c.key, c.dependsOn]));
  const state = new Map<string, 1 | 2>();
  const visit = (k: string, trail: string[]): void => {
    if (state.get(k) === 2) return;
    if (state.get(k) === 1) return void errs.push(`dependsOn cycle: ${[...trail, k].join(' -> ')}`);
    state.set(k, 1);
    for (const d of deps.get(k) ?? []) visit(d, [...trail, k]);
    state.set(k, 2);
  };
  for (const k of deps.keys()) visit(k, []);

  const skillKeys = new Set(lib.skills.map(s => s.key));
  const skillConcept = new Map(lib.skills.map(s => [s.key, s.concept]));
  for (const s of lib.skills) {
    if (!conceptKeys.has(s.concept)) errs.push(`skill "${s.key}": concept "${s.concept}" does not exist`);
    if (!SKILL_KINDS.includes(s.kind)) errs.push(`skill "${s.key}": kind "${s.kind}" is invalid`);
    if (!s.steps.length) errs.push(`skill "${s.key}": has no steps`);
    if (!Number.isInteger(s.keyStepIndex) || s.keyStepIndex < 0 || s.keyStepIndex >= s.steps.length)
      errs.push(`skill "${s.key}": keyStepIndex ${s.keyStepIndex} out of range 0..${s.steps.length - 1}`);
    if (!s.commonMistake.trim() || !s.tutorNote.trim()) errs.push(`skill "${s.key}": commonMistake and tutorNote must be non-empty`);
  }
  for (const c of lib.concepts) {
    const positions = lib.skills.filter(s => s.concept === c.key).map(s => String(s.position));
    for (const d of dupes(positions)) errs.push(`concept "${c.key}": duplicate skill position ${d}`);
  }

  for (const e of lib.explanations) {
    if (!conceptKeys.has(e.concept)) errs.push(`explanation "${e.id}": concept "${e.concept}" does not exist`);
    if (e.skill !== '') {
      if (!skillKeys.has(e.skill)) errs.push(`explanation "${e.id}": skill "${e.skill}" does not exist`);
      else if (skillConcept.get(e.skill) !== e.concept) errs.push(`explanation "${e.id}": skill "${e.skill}" belongs to another concept`);
    }
    if (!EXPLANATION_KINDS.includes(e.kind)) errs.push(`explanation "${e.id}": kind "${e.kind}" is invalid`);
  }

  for (const t of lib.tasks) {
    if (!skillKeys.has(t.skill)) errs.push(`task "${t.key}": skill "${t.skill}" does not exist`);
    if (!TASK_TYPES.includes(t.type)) errs.push(`task "${t.key}": type "${t.type}" is invalid`);
    if (![1, 2, 3].includes(t.difficulty)) errs.push(`task "${t.key}": difficulty ${t.difficulty} must be 1..3`);
    if (!ANSWER_FORMS.includes(t.answer?.form)) errs.push(`task "${t.key}": answer form "${t.answer?.form}" is invalid`);
    if (t.type === 'repair') {
      if (!Number.isInteger(t.wrongStepIndex) || t.wrongStepIndex < 0 || t.wrongStepIndex >= t.steps.length)
        errs.push(`task "${t.key}": repair wrongStepIndex ${t.wrongStepIndex} out of range 0..${t.steps.length - 1}`);
    } else if (t.wrongStepIndex !== -1) errs.push(`task "${t.key}": wrongStepIndex must be -1 for non-repair tasks`);
    if (t.type === 'gap' && t.show.split(BLANK).length !== 2) errs.push(`task "${t.key}": gap task needs exactly one ${BLANK} in show`);
  }
  return errs;
}

/** Every text exists twice: show (LaTeX) and say (plain words, no symbols). */
export function checkLibraryTexts(pack: LessonPack): string[] {
  const errs: string[] = [];
  const lib = pack.content;
  const say = (where: string, s: string | undefined) => {
    if (!s?.trim()) errs.push(`${where}: say is empty`);
    else if (SAY_FORBIDDEN.test(s)) errs.push(`${where}: say contains symbols or LaTeX: "${s}"`);
  };
  const show = (where: string, s: string | undefined) => {
    if (!s?.trim()) errs.push(`${where}: show is empty`);
  };
  for (const s of lib.skills) s.steps.forEach((st, i) => (show(`skill "${s.key}" step ${i}`, st.show), say(`skill "${s.key}" step ${i}`, st.say)));
  for (const e of lib.explanations) say(`explanation "${e.id}"`, e.say);
  for (const t of lib.tasks) {
    show(`task "${t.key}"`, t.show);
    say(`task "${t.key}"`, t.say);
    t.steps.forEach((st, i) => {
      show(`task "${t.key}" step ${i}`, st.show);
      say(`task "${t.key}" step ${i}`, st.say);
      if (st.hint !== undefined) say(`task "${t.key}" step ${i} hint`, st.hint);
    });
  }
  return errs;
}

export function checkExplanationBoardItems(pack: LessonPack): string[] {
  const errs: string[] = [];
  for (const e of pack.content.explanations) {
    e.boardItems.forEach((item, i) => {
      const kind = pack.boardKinds.find(k => k.name === item.kind);
      if (!kind) return void errs.push(`explanation "${e.id}" item ${i}: unknown board kind "${item.kind}"`);
      for (const m of validateJson(kind.contentSchema, item.content)) errs.push(`explanation "${e.id}" item ${i} (${item.kind}): ${m}`);
    });
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Task answers: every library answer is checked
// ---------------------------------------------------------------------------

function toRational(x: number): Rational {
  const r = decimalToRational(String(Math.abs(x)));
  return x < 0 ? rat(-r.n, r.d) : r;
}

function answerValue(form: string, value: string): Rational | null {
  if (form === 'fraction') {
    const f = parseFraction(value);
    if (!f) return null;
    const [n, d] = [toRational(f[0]), toRational(f[1])];
    return rat(n.n * d.d, n.d * d.n);
  }
  if (form === 'number') {
    const n = parseNumber(value);
    return n === null ? null : toRational(n);
  }
  return null;
}

type Expected = { form: 'fraction' | 'number' | 'relation'; value: string };

function stepExpected(step: TaskStep): Expected | null {
  if (step.expected === undefined) return null;
  const v = step.expected.trim();
  if (RELATIONS.includes(v)) return { form: 'relation', value: v };
  if (parseFraction(v)) return { form: 'fraction', value: v };
  if (parseNumber(v) !== null) return { form: 'number', value: v };
  return null;
}

/** The corrected version of a repair task's wrong step: "<first side> = expected", or for a
 *  relation "<left> expected <right>". */
function correctedStep(show: string, exp: Expected): Chain | null {
  const parts = show.split(REL_SPLIT).map(p => p.trim());
  if (exp.form === 'relation') return parts.length === 2 ? evaluateChain(`${parts[0]} ${exp.value} ${parts[1]}`) : null;
  return evaluateChain(`${parts[0]} = {${answerToLatex(exp.value)}}`);
}

/** Does the chain's last side match (value, exact written form for fractions, relation for <, >, =)? */
function chainMatches(chain: Chain, exp: Expected): boolean {
  if (exp.form === 'relation') return chain.relations.length > 0 && chain.relations.every(r => r === exp.value);
  const want = answerValue(exp.form, exp.value);
  if (!want || !ratEquals(chain.sides[chain.sides.length - 1]!, want)) return false;
  if (exp.form === 'fraction') {
    const lit = literalFraction(chain.lastRaw);
    const f = parseFraction(exp.value)!;
    if (lit && (lit[0] !== f[0] || lit[1] !== f[1])) return false;
  }
  return true;
}

function wrongAlternatives(form: string, value: string): string[] {
  if (form === 'number') {
    const v = answerValue('number', value);
    return v ? [String((v.n + v.d) / v.d)] : [];
  }
  if (form === 'fraction') {
    const f = parseFraction(value);
    return f ? [`${f[0] + 1}/${f[1]}`] : [];
  }
  if (RELATIONS.includes(value.trim())) return RELATIONS.filter(r => r !== value.trim());
  return [];
}

/**
 * Checks one library task's answer:
 * - checkAnswer accepts answer.value for its own form;
 * - every checkable step equation holds, except a repair task's wrong step, which must be
 *   wrong and become right with its `expected`;
 * - each step's `expected` matches its equation; without a blank, the last step's `expected`
 *   equals the answer;
 * - the answer is derived: a task with one \square is solved by the answer (and not by a
 *   neighbouring value); otherwise the last checkable step must end in the answer.
 */
export function checkTaskAnswer(t: LibraryTask): string[] {
  const errs: string[] = [];
  const where = `task "${t.key}"`;
  const { form, value } = t.answer;
  if (!value?.trim()) return [`${where}: answer value is empty`];
  if (!checkAnswer(t.answer, value)) errs.push(`${where}: checkAnswer rejects its own answer "${value}" (${form})`);
  if (form === 'fraction' && !parseFraction(value)) errs.push(`${where}: answer "${value}" is not a fraction`);
  if (form === 'number' && parseNumber(value) === null) errs.push(`${where}: answer "${value}" is not a number`);
  const answerExp: Expected | null =
    form === 'number' || form === 'fraction'
      ? { form, value }
      : form === 'choice' && RELATIONS.includes(value.trim())
        ? { form: 'relation', value: value.trim() }
        : null;

  let lastChecked: Chain | null = null;
  t.steps.forEach((st, i) => {
    const chain = evaluateChain(st.show);
    const exp = stepExpected(st);
    if (t.type === 'repair' && i === t.wrongStepIndex) {
      if (!chain) return void errs.push(`${where}: wrong step ${i} must be checkable math`);
      if (chain.holds) errs.push(`${where}: wrong step ${i} "${st.show}" is actually correct`);
      if (!exp) return void errs.push(`${where}: wrong step ${i} needs \`expected\` (the correct result)`);
      const fixed = correctedStep(st.show, exp);
      if (!fixed?.holds) errs.push(`${where}: wrong step ${i} is still wrong with expected "${exp.value}"`);
      else lastChecked = fixed;
      return;
    }
    if (!chain) return;
    if (!chain.holds) errs.push(`${where}: step ${i} "${st.show}" does not hold`);
    if (exp && !chainMatches(chain, exp)) errs.push(`${where}: step ${i} expected "${exp.value}" does not match "${st.show}"`);
    lastChecked = chain;
  });

  const last = t.steps[t.steps.length - 1];
  const lastExp = last && stepExpected(last);
  // (Tasks with a blank are solved by the blank; their steps may end on an intermediate value.)
  if (answerExp && lastExp && !t.show.includes(BLANK) && (lastExp.form === 'relation' ? lastExp.value !== answerExp.value : !checkAnswer(t.answer, lastExp.value)))
    errs.push(`${where}: last step expected "${lastExp.value}" differs from answer "${value}"`);

  if (!answerExp) return errs;
  if (t.show.includes(BLANK)) {
    const filled = fillBlank(t.show, value);
    const chain = filled && evaluateChain(filled);
    if (!chain) errs.push(`${where}: cannot check the blank in "${t.show}" (use plain math with exactly one ${BLANK})`);
    else if (!chain.holds) errs.push(`${where}: answer "${value}" does not solve "${t.show}"`);
    for (const alt of wrongAlternatives(form, value)) {
      const c = evaluateChain(fillBlank(t.show, alt) ?? '');
      if (c?.holds) errs.push(`${where}: the blank is ambiguous, "${alt}" also solves it`);
    }
  } else {
    const final = lastChecked as Chain | null;
    if (!final) errs.push(`${where}: no checkable step derives the answer "${value}"`);
    else if (!chainMatches(final, answerExp)) errs.push(`${where}: answer "${value}" does not match the last checkable step`);
  }
  return errs;
}

export function checkTaskAnswers(pack: LessonPack): string[] {
  return pack.content.tasks.flatMap(checkTaskAnswer);
}

/** Skill steps (general recipe) may contain letters; checkable ones must hold. */
export function checkSkillSteps(pack: LessonPack): string[] {
  const errs: string[] = [];
  for (const s of pack.content.skills)
    s.steps.forEach((st, i) => {
      const c = evaluateChain(st.show);
      if (c && !c.holds) errs.push(`skill "${s.key}" step ${i} "${st.show}" does not hold`);
    });
  return errs;
}

// ---------------------------------------------------------------------------
// Tool specs generated from the pack
// ---------------------------------------------------------------------------

export function checkToolSpecs(pack: LessonPack): string[] {
  const errs: string[] = [];
  const specs = buildToolSpecs(pack);
  for (const d of dupes(specs.map(s => s.name))) errs.push(`duplicate tool "${d}"`);
  const byName = new Map(specs.map(s => [s.name, s.parameters as JsonSchema]));
  for (const s of specs) {
    const p = s.parameters as JsonSchema;
    if (!s.description.trim()) errs.push(`tool "${s.name}": empty description`);
    if (p.type !== 'object' || !p.properties) errs.push(`tool "${s.name}": parameters must be an object schema`);
    else errs.push(...checkSchemaShape(p, `tool "${s.name}"`));
  }
  const sameSet = (what: string, got: readonly (string | number)[] | undefined, want: string[]) => {
    const g = [...(got ?? [])].map(String).sort();
    const w = [...want].sort();
    if (g.join('|') !== w.join('|')) errs.push(`${what}: enum [${g}] does not match the pack [${w}]`);
  };
  const phase = byName.get(TOOL_NAMES.setPhase);
  const board = byName.get(TOOL_NAMES.showBoardItem);
  const topic = byName.get(TOOL_NAMES.setTopic);
  if (!phase || !board || !topic) return [...errs, 'missing set_phase, show_board_item or set_topic'];
  sameSet('set_phase.phase', phase.properties?.phase?.enum, pack.phases.map(p => p.id));
  sameSet('show_board_item.kind', board.properties?.kind?.enum, boardKindNames(pack));
  sameSet('set_topic.category', topic.properties?.category?.enum, pack.taxonomy.map(c => c.key));
  sameSet('set_topic.concept', topic.properties?.concept?.enum, pack.taxonomy.flatMap(c => c.concepts.map(k => k.key)));

  // The schemas accept pack values and reject others.
  if (validateJson(phase, { phase: pack.finalPhase, reason: 'done' }).length) errs.push('set_phase rejects a valid phase');
  if (!validateJson(phase, { phase: '__not_a_phase__', reason: 'x' }).length) errs.push('set_phase accepts an unknown phase');
  const kind = pack.boardKinds[0];
  if (kind && validateJson(board, { kind: kind.name, content: {} }).length) errs.push('show_board_item rejects a valid kind');
  if (!validateJson(board, { kind: '__not_a_kind__' }).length) errs.push('show_board_item accepts an unknown kind');
  const cat = pack.taxonomy[0];
  if (cat && validateJson(topic, { category: cat.key, ...(cat.concepts[0] ? { concept: cat.concepts[0].key } : {}) }).length)
    errs.push('set_topic rejects a valid category/concept');
  return errs;
}

// ---------------------------------------------------------------------------

export const PACK_CHECKS = {
  phases: checkPhases,
  boardKinds: checkBoardKinds,
  prompts: checkPrompts,
  taxonomy: checkTaxonomy,
  libraryIntegrity: checkLibraryIntegrity,
  libraryTexts: checkLibraryTexts,
  explanationBoardItems: checkExplanationBoardItems,
  skillSteps: checkSkillSteps,
  taskAnswers: checkTaskAnswers,
  toolSpecs: checkToolSpecs,
} as const;

/** All contract violations of a pack ([] = the pack is valid). */
export function checkPack(pack: LessonPack): string[] {
  return Object.values(PACK_CHECKS).flatMap(check => check(pack));
}
