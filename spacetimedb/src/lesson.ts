// Lesson logic: phases, board, gap answers, topic + context. Every phase id, board kind and
// template comes from the lesson pack; nothing here names one.
import { SenderError } from 'spacetimedb/server';
import { MODULE_DEFAULTS } from '../../shared/src/config';
import { pack } from '../../shared/src/lesson/index';
import type { BoardKindDef, JsonSchema, LibraryTask } from '../../shared/src/lesson/types';
import { canTransition, conceptBelongsTo, getBoardKind, getPhase, isCategory, renderTemplate, validateJson } from '../../shared/src/lesson/api';
import { checkAnswer } from '../../shared/src/answers';
import { GAP_STATES, type ExpectedAnswer, type GapState, type MemoryKind } from '../../shared/src/types';
import { type Ctx, type BoardItemRow, type SessionRow, findSentence, getActiveSession, getSession, parseJson, truncate, updateSession } from './ctx';

const [GAP_OPEN, GAP_CORRECT, GAP_WRONG] = GAP_STATES as unknown as [GapState, GapState, GapState];
// Exhaustive over ExpectedAnswer['form'] (keys, so no string literal collides with a pack kind name).
const ANSWER_FORM_SET = { number: true, fraction: true, choice: true, text: true } satisfies Record<ExpectedAnswer['form'], true>;
const ANSWER_FORMS = Object.keys(ANSWER_FORM_SET) as ExpectedAnswer['form'][];

// ---------------------------------------------------------------- phases

export function setPhase(ctx: Ctx, args: { sessionId: bigint; phase: string; reason: string }): void {
  const session = getActiveSession(ctx, args.sessionId);
  if (!getPhase(pack, args.phase)) {
    throw new SenderError(`unknown phase ${args.phase}; phases: ${pack.phases.map(p => p.id).join(', ')}`);
  }
  if (!canTransition(pack, session.phase, args.phase)) {
    const next = getPhase(pack, session.phase)?.next ?? [];
    throw new SenderError(`cannot move from ${session.phase} to ${args.phase}; allowed: ${next.join(', ') || 'none (last phase)'}`);
  }
  updateSession(ctx, session, { phase: args.phase });
}

// ---------------------------------------------------------------- board kinds, derived from the pack schemas

const props = (k: BoardKindDef): Record<string, JsonSchema> => k.contentSchema.properties ?? {};
/** Kinds whose tool description demands an expected answer (gap tasks in the placeholder pack). */
const isAnswerable = (k: BoardKindDef) => /expectedAnswer/.test(k.description);
const hasStepList = (k: BoardKindDef) => props(k).steps?.type === 'array';
const hasLatex = (k: BoardKindDef) => props(k).latex?.type === 'string';
const hasText = (k: BoardKindDef) => props(k).text?.type === 'string';

function pickKind(pred: (k: BoardKindDef) => boolean): BoardKindDef | undefined {
  return pack.boardKinds.find(pred);
}

const GAP_TASK: LibraryTask['type'] = 'gap';
const SOLO_TASK: LibraryTask['type'] = 'solo';

/** Library task -> board kind, by shape: gap tasks -> the answerable LaTeX kind; solo tasks -> the plain
 *  LaTeX kind (then text); tasks that are a solution process (worked examples, repairs) -> the step list.
 *  The agent may pass a kind explicitly to override. */
function kindForTask(task: LibraryTaskRow): BoardKindDef | undefined {
  const latexKind = pickKind(k => hasLatex(k) && !isAnswerable(k) && !hasStepList(k));
  const textKind = pickKind(k => hasText(k) && !isAnswerable(k));
  const steps = parseJson<unknown[]>(task.steps, []);
  if (task.type === GAP_TASK) return pickKind(k => isAnswerable(k) && hasLatex(k)) ?? latexKind ?? textKind;
  if (task.type !== SOLO_TASK && steps.length > 0) return pickKind(hasStepList) ?? latexKind ?? textKind;
  return latexKind ?? textKind;
}

function fit(schema: JsonSchema | undefined, s: string): string {
  return schema?.maxLength ? truncate(s, schema.maxLength) : s;
}

/** Builds content for `kind` from a library task, filling whichever fields the kind's schema has. */
function contentFromTask(kind: BoardKindDef, task: LibraryTaskRow): Record<string, unknown> {
  const p = props(kind);
  const out: Record<string, unknown> = {};
  if (hasStepList(kind)) {
    const itemProps = p.steps!.items?.properties ?? {};
    const max = p.steps!.maxItems ?? 8;
    const steps = parseJson<LibraryTask['steps']>(task.steps, []).slice(0, max);
    out.steps = steps.map(s => {
      const step: Record<string, unknown> = {};
      if (itemProps.show) step.show = fit(itemProps.show, s.show);
      if (itemProps.note && s.say) step.note = fit(itemProps.note, s.say);
      return step;
    });
    if (p.title) out.title = fit(p.title, task.say || task.show);
    return out;
  }
  if (p.latex) out.latex = fit(p.latex, task.show);
  if (p.prompt) out.prompt = fit(p.prompt, task.say);
  else if (p.caption && task.say) out.caption = fit(p.caption, task.say);
  if (p.text && !p.latex) out.text = fit(p.text, task.say || task.show);
  return out;
}

type LibraryTaskRow = NonNullable<ReturnType<Ctx['db']['task']['key']['find']>>;

function parseExpected(raw: string): ExpectedAnswer | null {
  if (!raw.trim()) return null;
  const v = parseJson<Partial<ExpectedAnswer> | null>(raw, null);
  if (!v || typeof v !== 'object') throw new SenderError('expectedAnswer must be JSON {form, value}');
  if (!ANSWER_FORMS.includes(v.form as ExpectedAnswer['form'])) throw new SenderError(`expectedAnswer.form must be one of ${ANSWER_FORMS.join(', ')}`);
  const value = typeof v.value === 'number' ? String(v.value) : v.value;
  if (typeof value !== 'string' || !value.trim()) throw new SenderError('expectedAnswer.value must be a non-empty string');
  return { form: v.form as ExpectedAnswer['form'], value: value.trim() };
}

export function showBoardItem(
  ctx: Ctx,
  args: {
    sessionId: bigint;
    utteranceId: bigint;
    sentenceIdx: number;
    markerPos?: number;
    kind: string;
    content: string;
    taskKey: string;
    expectedAnswer: string;
  }
): BoardItemRow {
  const session = getActiveSession(ctx, args.sessionId);
  const markerPos = revealMarkerPos(ctx, args);
  let kind: BoardKindDef | undefined;
  let content: unknown;
  let expected = parseExpected(args.expectedAnswer);
  const taskKey = args.taskKey.trim();

  if (taskKey && !args.content.trim()) {
    const task = ctx.db.task.key.find(taskKey);
    if (!task) throw new SenderError(`unknown taskKey ${taskKey}`);
    kind = args.kind ? getBoardKind(pack, args.kind) : kindForTask(task);
    if (!kind) throw new SenderError(args.kind ? `unknown board kind ${args.kind}` : `no board kind fits task ${taskKey}`);
    content = contentFromTask(kind, task);
    const answer = parseJson<ExpectedAnswer | null>(task.answer, null);
    if (answer && ANSWER_FORMS.includes(answer.form) && String(answer.value ?? '').trim()) {
      expected = { form: answer.form, value: String(answer.value) };
    }
  } else {
    kind = getBoardKind(pack, args.kind);
    if (!kind) throw new SenderError(`unknown board kind ${args.kind}; kinds: ${pack.boardKinds.map(k => k.name).join(', ')}`);
    if (args.content.length > MODULE_DEFAULTS.BOARD_CONTENT_MAX) throw new SenderError(`content too large (max ${MODULE_DEFAULTS.BOARD_CONTENT_MAX} chars)`);
    content = parseJson<unknown>(args.content, undefined);
    if (content === undefined) throw new SenderError('content must be a JSON object');
  }

  const json = JSON.stringify(content);
  if (json.length > MODULE_DEFAULTS.BOARD_CONTENT_MAX) throw new SenderError(`content too large (max ${MODULE_DEFAULTS.BOARD_CONTENT_MAX} chars)`);
  const errors = validateJson(kind.contentSchema, content);
  if (errors.length) throw new SenderError(`invalid content for ${kind.name}: ${errors.slice(0, 5).join('; ')}`);
  if (isAnswerable(kind) && !expected) throw new SenderError(`${kind.name} needs expectedAnswer`);

  const idx = [...ctx.db.boardItem.sessionId.filter(session.id)].length;
  const item = ctx.db.boardItem.insert({
    id: 0n,
    sessionId: session.id,
    idx,
    kind: kind.name,
    content: json,
    phase: session.phase,
    visible: true,
    utteranceId: args.utteranceId,
    sentenceIdx: args.sentenceIdx,
    taskKey,
    answerState: expected ? GAP_OPEN : '',
    lastAnswer: '',
    createdAt: ctx.timestamp,
    markerPos,
  });
  if (expected) ctx.db.boardAnswer.insert({ boardItemId: item.id, answer: JSON.stringify(expected) });
  return item;
}

/** Validated inline-marker anchor: an offset into the speech of the tagged sentence, clamped to
 *  its length. A marker whose sentence does not exist (e.g. it failed to add) falls back to -1,
 *  i.e. the reveal at the start of that sentence, instead of losing the item. */
function revealMarkerPos(ctx: Ctx, args: { utteranceId: bigint; sentenceIdx: number; markerPos?: number }): number {
  const pos = args.markerPos ?? -1;
  if (!Number.isInteger(pos) || pos < -1) throw new SenderError(`markerPos must be -1 or a character offset, got ${pos}`);
  if (pos < 0 || args.utteranceId === 0n) return -1;
  const sentence = findSentence(ctx, args.utteranceId, args.sentenceIdx);
  if (!sentence) return -1;
  return Math.min(pos, sentence.speech.length);
}

export function clearBoard(ctx: Ctx, sessionId: bigint): void {
  getActiveSession(ctx, sessionId);
  for (const item of [...ctx.db.boardItem.sessionId.filter(sessionId)]) {
    if (item.visible) ctx.db.boardItem.id.update({ ...item, visible: false });
  }
}

export function submitGapAnswer(ctx: Ctx, args: { boardItemId: bigint; answer: string }): boolean {
  const item = ctx.db.boardItem.id.find(args.boardItemId);
  if (!item) throw new SenderError(`board item ${args.boardItemId} not found`);
  const stored = ctx.db.boardAnswer.boardItemId.find(item.id);
  if (!stored) throw new SenderError('this board item has no answer to check');
  const expected = parseJson<ExpectedAnswer | null>(stored.answer, null);
  if (!expected) throw new SenderError('stored answer is invalid');
  const answer = truncate(args.answer.trim(), 100);
  const ok = checkAnswer(expected, answer);
  ctx.db.boardItem.id.update({ ...item, answerState: ok ? GAP_CORRECT : GAP_WRONG, lastAnswer: answer });
  return ok;
}

// ---------------------------------------------------------------- topic material

function topicMaterial(ctx: Ctx, category: string, concept: string): Record<string, unknown> {
  const cat = pack.taxonomy.find(c => c.key === category)!;
  const libCat = ctx.db.category.key.find(category);
  const concepts = cat.concepts.map(k => {
    const lib = ctx.db.concept.key.find(k.key);
    return {
      key: k.key,
      title: lib?.title ?? k.title,
      summary: lib?.summary ?? '',
      gradeBand: lib?.gradeBand ?? '',
      dependsOn: parseJson<string[]>(lib?.dependsOn ?? '[]', []),
    };
  });
  const out: Record<string, unknown> = { category: { key: category, title: libCat?.title ?? cat.title }, concepts };
  if (concept) {
    const skills = [...ctx.db.skill.concept.filter(concept)]
      .sort((a, b) => a.position - b.position)
      .map(s => ({
        key: s.key,
        position: s.position,
        title: s.title,
        kind: s.kind,
        steps: parseJson(s.steps, []),
        keyStepIndex: s.keyStepIndex,
        commonMistake: s.commonMistake,
        tutorNote: s.tutorNote,
      }));
    const explanations = [...ctx.db.explanation.concept.filter(concept)].map(e => ({
      id: e.id,
      skill: e.skill,
      kind: e.kind,
      say: e.say,
      boardItems: parseJson(e.boardItems, []),
    }));
    const tasks = [...ctx.db.task.concept.filter(concept)]
      .sort((a, b) => (a.skill === b.skill ? a.difficulty - b.difficulty : a.skill < b.skill ? -1 : 1))
      .map(t => ({
        key: t.key,
        skill: t.skill,
        type: t.type,
        difficulty: t.difficulty,
        show: t.show,
        say: t.say,
        answer: parseJson(t.answer, null),
        steps: parseJson(t.steps, []),
        wrongStepIndex: t.wrongStepIndex,
      }));
    out.concept = { key: concept, skills, explanations, tasks };
    if (!skills.length && !explanations.length && !tasks.length) {
      out.note = 'No library entries for this concept: create material yourself in the same shape and always pass expectedAnswer.';
    }
  }
  return out;
}

function learnerNotesFor(ctx: Ctx, learnerId: bigint, category: string) {
  const notes = [...ctx.db.memoryNote.learnerId.filter(learnerId)]
    .filter(n => n.category === category)
    .map(n => ({ id: Number(n.id), kind: n.kind, concept: n.concept, text: n.text, outcome: n.outcome, reinforced: n.reinforced }));
  const concepts = [...ctx.db.conceptState.learnerId.filter(learnerId)]
    .filter(c => c.category === category)
    .map(c => ({ concept: c.concept, mastery: c.mastery }));
  return { notes, concepts };
}

export function setTopic(ctx: Ctx, args: { sessionId: bigint; category: string; concept: string }): string {
  const session = getActiveSession(ctx, args.sessionId);
  const category = args.category.trim();
  const concept = args.concept.trim();
  if (!isCategory(pack, category)) {
    return JSON.stringify({ ok: false, error: `unknown category ${category}; categories: ${pack.taxonomy.map(c => c.key).join(', ')}`, material: null, notes: null });
  }
  if (concept && !conceptBelongsTo(pack, category, concept)) {
    const valid = pack.taxonomy.find(c => c.key === category)!.concepts.map(k => k.key);
    return JSON.stringify({ ok: false, error: `concept ${concept} is not in ${category}; concepts: ${valid.join(', ')}`, material: null, notes: null });
  }
  updateSession(ctx, session, { category, concept });
  return JSON.stringify({ ok: true, material: topicMaterial(ctx, category, concept), notes: learnerNotesFor(ctx, session.learnerId, category) });
}

// ---------------------------------------------------------------- context

const PREFERENCE_KIND: MemoryKind = 'preference';

export function describeLearner(ctx: Ctx, session: SessionRow): string {
  const l = ctx.db.learner.id.find(session.learnerId);
  if (!l) return 'unknown learner';
  return `${l.name}, age ${l.age}, grade ${l.grade}.${l.style ? ` Learning style: ${l.style}.` : ''}`;
}

export function describeMemory(ctx: Ctx, session: SessionRow): string {
  const lines: string[] = [];
  const notes = [...ctx.db.memoryNote.learnerId.filter(session.learnerId)].sort((a, b) => (a.updatedAt.microsSinceUnixEpoch < b.updatedAt.microsSinceUnixEpoch ? 1 : -1));
  for (const n of notes) {
    if (n.kind === PREFERENCE_KIND || (session.category && n.category === session.category)) {
      const where = n.concept || n.category;
      const outcome = n.outcome && n.outcome !== 'unknown' ? ` (${n.outcome})` : '';
      lines.push(`- ${n.kind} [${where}]: ${n.text}${outcome}${n.reinforced ? ` x${n.reinforced + 1}` : ''}`);
    }
  }
  if (session.category) {
    for (const c of ctx.db.conceptState.learnerId.filter(session.learnerId)) {
      if (c.category === session.category) lines.push(`- mastery ${c.concept}: ${c.mastery}/100`);
    }
  }
  let last: { summary: string; nextFocus: string; at: bigint } | undefined;
  for (const s of ctx.db.sessionSummary.learnerId.filter(session.learnerId)) {
    if (s.sessionId === session.id) continue;
    if (!last || s.createdAt.microsSinceUnixEpoch > last.at) last = { summary: s.summary, nextFocus: s.nextFocus, at: s.createdAt.microsSinceUnixEpoch };
  }
  if (last) lines.push(`- last session: ${last.summary}${last.nextFocus ? ` Next focus: ${last.nextFocus}` : ''}`);
  return lines.length ? '\n' + lines.join('\n') : 'nothing yet';
}

function describeBoard(ctx: Ctx, sessionId: bigint): string {
  const items = [...ctx.db.boardItem.sessionId.filter(sessionId)].filter(i => i.visible).sort((a, b) => a.idx - b.idx);
  if (!items.length) return 'empty';
  return (
    '\n' +
    items
      .map(i => {
        const state = i.answerState ? ` [answer: ${i.answerState}${i.lastAnswer ? `, last "${i.lastAnswer}"` : ''}]` : '';
        const key = i.taskKey ? ` (task ${i.taskKey})` : '';
        return `- #${i.idx} ${i.kind}${key}: ${truncate(i.content, 400)}${state}`;
      })
      .join('\n')
  );
}

export function buildContext(ctx: Ctx, sessionId: bigint): string {
  const session = getSession(ctx, sessionId);
  const phase = getPhase(pack, session.phase);
  const phaseText = phase ? `${phase.id} (${phase.label}). Allowed next: ${phase.next.join(', ') || 'none, this is the last phase'}.` : session.phase;
  const task = (session.taskText.trim() || '(no task text)') + (session.hasImage ? ' A photo of the task was uploaded.' : '');
  let out = renderTemplate(pack.prompts.context, {
    learner: describeLearner(ctx, session),
    memory: describeMemory(ctx, session),
    task,
    phase: phaseText,
    board: describeBoard(ctx, sessionId),
  });
  if (session.category) {
    out += `\n\nTopic: ${session.category}${session.concept ? ` / ${session.concept}` : ''}`;
    out += `\nLibrary material: ${JSON.stringify(topicMaterial(ctx, session.category, session.concept))}`;
  } else {
    out += '\n\nTopic: not set yet. Find it and call set_topic.';
  }
  return out;
}
