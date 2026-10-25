// SpacetimeDB planning adapter: the team's PlanningModel contract over SpacetimeDB rows.
//
// Trigger  = a reducer call (submitTextTurn with an intent, submitInteraction choice/submit,
//            startConversation).
// Response = the session's `beat` rows of the NEXT tutor utterance (one row per complete moment,
//            compiled + validated by the module) and the step the module accepts at the final beat
//            (public view in `lesson_state.notes`). A tutor turn that ends without an accepted step
//            is an error. Abort = `interrupt`.
// The module is authoritative (assessment, evidence, answer keys). A TeachingSession on this
// adapter presents the lesson; its local assessment uses placeholder answer keys and is not
// meaningful — the product screen (client SessionView) reads lesson_state instead.
// See docs/CONTRACT-night.md sections 1 and 4.
//
// Pure TypeScript: `LessonFeed` is the seam (unit tests use a fake; `connectionFeed` wraps a
// generated DbConnection structurally, so this file never imports client bindings).
import { z } from "zod";
import type { PlanningModel, PlanningRequest } from "./TeachingPlanner";
import { PhaseSchema, TeachingStepSchema, type TeachingCheck, type TeachingStep } from "./contracts";
import { VisualBeatSchema, type VisualBeat } from "../presentation/contracts";
import { blueprintOf } from "./streaming";

// ---------------------------------------------------------------- row shapes (structural)

export interface BeatRowLike {
  id: bigint;
  sessionId: bigint;
  utteranceId: bigint;
  idx: number;
  /** JSON: a VisualBeat without narration ({id?, cues, question?}), {commands}, or a command array. */
  visual: string;
  narration: string;
  sentenceIdx: number;
  canvasVersion: number;
}
export interface LessonStateLike {
  sessionId: bigint;
  stage: string;
  awaitingResponse: boolean;
  checkPrompt: string;
  evidence: string;
  notes: string;
}
export interface TurnRowLike {
  sessionId: bigint;
  role: string;
  utteranceId: bigint;
  interrupted: boolean;
}
export interface SessionRowLike {
  id: bigint;
  turnCount: number;
  currentUtteranceId: bigint;
  turnState: string;
  active: boolean;
}
export interface LessonFeedSnapshot {
  beats: readonly BeatRowLike[];
  tutorTurns: readonly TurnRowLike[];
  lessonState: LessonStateLike | undefined;
  session: SessionRowLike | undefined;
}
export interface LessonFeed {
  snapshot(): LessonFeedSnapshot;
  /** Called after any change of the session's rows. */
  subscribe(listener: () => void): () => void;
  submitTextTurn(text: string, intent: LessonIntent): Promise<void>;
  submitInteraction(kind: string, payload: string): Promise<void>;
  startConversation(): Promise<void>;
  interrupt(): Promise<void>;
}

/** `turn.intent` values (docs/CONTRACT-night.md). */
export type LessonIntent = "" | "another_way" | "smaller_step" | "continue" | "demonstrate";
export const HELP_INTENTS: Record<string, LessonIntent> = {
  another_way: "another_way",
  simpler: "smaller_step",
  hint: "smaller_step",
  explain: "demonstrate",
};

// ---------------------------------------------------------------- row → team contracts

const CueListSchema = z.array(z.unknown());
/** One `beat` row as the team's VisualBeat (narration from the row). Throws on malformed JSON. */
export function beatRowToVisual(row: BeatRowLike): VisualBeat {
  const raw: unknown = JSON.parse(row.visual || "null");
  const id = `beat-${row.utteranceId}-${row.idx}`;
  let beat: Record<string, unknown>;
  if (Array.isArray(raw)) beat = { id, cues: [{ id: `${id}-cue`, atMs: 0, commands: raw }] };
  else if (raw && typeof raw === "object" && Array.isArray((raw as { cues?: unknown }).cues)) {
    const { narration: _n, ...rest } = raw as Record<string, unknown>;
    beat = { id, ...rest };
  } else if (raw && typeof raw === "object" && CueListSchema.safeParse((raw as { commands?: unknown }).commands).success)
    beat = { id: (raw as { id?: string }).id ?? id, cues: [{ id: `${id}-cue`, atMs: 0, commands: (raw as { commands: unknown[] }).commands }] };
  else throw new Error(`Beat ${row.idx} has no visual commands.`);
  return VisualBeatSchema.parse({ ...beat, narration: row.narration || " " });
}

/** Rows of one utterance in idx order, stopping at the first gap (later rows wait for it). */
export function contiguousBeats(beats: readonly BeatRowLike[], utteranceId: bigint): BeatRowLike[] {
  const mine = beats.filter(b => b.utteranceId === utteranceId).sort((a, b) => a.idx - b.idx);
  const out: BeatRowLike[] = [];
  for (const b of mine) {
    if (b.idx !== out.length) break;
    out.push(b);
  }
  return out;
}

// lesson_state.notes (night/pipeline, spacetimedb/src/pipeline.ts publishState): the accepted step's
// public view. The check comes without its answer key (the module assesses).
const PublicCheckSchema = z.object({ kind: z.string(), prompt: z.string() }).passthrough();
const NotesSchema = z.object({
  stepId: z.string().nullable().optional(),
  phase: z.string().nullable().optional(),
  learningGoal: z.string().nullable().optional(),
  approach: z.string().nullable().optional(),
  beatCount: z.number().optional(),
  check: PublicCheckSchema.nullable().optional(),
}).passthrough();
export type LessonNotes = z.infer<typeof NotesSchema>;

export function parseNotes(state: LessonStateLike | undefined): LessonNotes {
  try { return NotesSchema.parse(JSON.parse(state?.notes || "{}")); } catch { return {}; }
}

const ASSESSED = "tutor-assessed";
/** The team TeachingCheck for a public check. The answer key stays in the module; the client-side
 *  fields it needs for schema validity are placeholders, so client-side assessment is not meaningful
 *  (the authoritative evidence is `lesson_state.evidence`). */
export function checkFromPublic(input: unknown): TeachingCheck | null {
  const c = PublicCheckSchema.safeParse(input);
  if (!c.success) return null;
  const v = c.data as Record<string, unknown> & { kind: string; prompt: string };
  const zero = { operation: "value" as const, value: 0 };
  switch (v.kind) {
    case "choice": {
      const options = Array.isArray(v.options) ? (v.options as { id: string; label: string }[]) : [];
      return options.length >= 2 ? { kind: "choice", prompt: v.prompt, options, correctOptionId: options[0]!.id } : null;
    }
    case "number": return { kind: "number", prompt: v.prompt, rule: zero };
    case "math_value": return { kind: "math_value", prompt: v.prompt, visualId: String(v.visualId), field: v.field as never, ...(v.itemId ? { itemId: String(v.itemId) } : {}), rule: zero };
    case "placement": return { kind: "placement", prompt: v.prompt, sceneId: String(v.sceneId), objectId: String(v.objectId), containerId: ASSESSED };
    case "order": return { kind: "order", prompt: v.prompt, sceneId: String(v.sceneId), objectIds: [`${ASSESSED}-1`, `${ASSESSED}-2`] };
    default: return { kind: "explanation", prompt: v.prompt, rubric: ["Assessed by the tutor."] };
  }
}

/** The accepted step of an utterance as the team TeachingStep (metadata from lesson_state.notes). */
export function stepFromRows(state: LessonStateLike | undefined, beats: VisualBeat[]): TeachingStep {
  const notes = parseNotes(state);
  const phase = PhaseSchema.safeParse(notes.phase);
  const p = phase.success ? phase.data : "intuition";
  const approach = z.enum(["introduce", "continue", "simplify", "change_representation", "hint", "challenge", "handoff"]).safeParse(notes.approach);
  return TeachingStepSchema.parse({
    id: notes.stepId ?? `step-${Date.now()}`,
    phase: p,
    learningGoal: notes.learningGoal || "Understand the idea in the picture.",
    approach: approach.success ? approach.data : p === "return_to_problem" ? "handoff" : "continue",
    rationale: "Planned by the tutor.",
    ...(["worked_example", "solo", "transfer"].includes(p) ? { exampleProblem: "The example in the picture." } : {}),
    beats,
    check: checkFromPublic(notes.check),
    evidenceToObserve: ["The learner's response to the picture."],
    assessment: null,
  });
}

// ---------------------------------------------------------------- request → trigger

export type LessonTrigger =
  | { kind: "start" }
  | { kind: "text"; text: string; intent: LessonIntent }
  | { kind: "interaction"; interaction: "choice" | "submit"; payload: string };

/** Which reducer call a planning request stands for. `sent` holds the evidence/context ids
 *  already submitted by this model instance (a retry never duplicates a learner turn). */
export function triggerFor(request: PlanningRequest, sent: ReadonlySet<string>): { trigger: LessonTrigger; key: string } {
  const { context } = request;
  const latest = context.evidence.at(-1);
  if (latest && !sent.has(latest.eventId)) {
    const r = latest.response;
    const key = latest.eventId;
    if (r.kind === "answer") return { key, trigger: { kind: "text", text: r.text, intent: "" } };
    // The module assesses choices and pictures itself, then submits the learner turn.
    if (r.kind === "choice") return { key, trigger: { kind: "interaction", interaction: "choice", payload: JSON.stringify({ optionId: r.optionId }) } };
    if (r.kind === "interaction") return { key, trigger: { kind: "interaction", interaction: "submit", payload: "{}" } };
    return { key, trigger: { kind: "text", text: "", intent: HELP_INTENTS[r.request] ?? "continue" } };
  }
  const spoken = context.session.context.at(-1);
  if (spoken && !sent.has(spoken.id)) return { key: spoken.id, trigger: { kind: "text", text: spoken.text, intent: "" } };
  if (!context.currentStep && context.recentSteps.length === 0) return { key: `start:${request.requestId}`, trigger: { kind: "start" } };
  return { key: `continue:${request.requestId}`, trigger: { kind: "text", text: "", intent: "continue" } };
}

// ---------------------------------------------------------------- the model

export interface SpacetimeModelOptions {
  /** No first beat within this time → error (the worker is down or busy). */
  firstBeatTimeoutMs?: number;
  /** No progress for this long after the first beat → error. */
  stallTimeoutMs?: number;
}

const knownUtterances = (s: LessonFeedSnapshot) => {
  let max = 0n;
  for (const b of s.beats) if (b.utteranceId > max) max = b.utteranceId;
  for (const t of s.tutorTurns) if (t.utteranceId > max) max = t.utteranceId;
  if (s.session && s.session.currentUtteranceId > max) max = s.session.currentUtteranceId;
  return max;
};

/** PlanningModel over a LessonFeed: trigger, then follow the next utterance's rows.
 *  The module accepts a streamed lesson as a whole at its final beat (the step metadata becomes
 *  public in lesson_state then), so the blueprint and the beats are reported in arrival order at
 *  that moment, followed by the complete step. */
export function createFeedPlanningModel(feed: LessonFeed, options: SpacetimeModelOptions = {}): PlanningModel {
  const sent = new Set<string>();
  const firstBeatMs = options.firstBeatTimeoutMs ?? 60_000;
  const stallMs = options.stallTimeoutMs ?? 30_000;
  return (request, signal, onProgress) => new Promise<unknown>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("Planning cancelled.")); return; }
    // Everything up to here belongs to earlier replies; the answer is the first newer utterance.
    const start = feed.snapshot();
    const baseline = knownUtterances(start);
    const baselineStep = parseNotes(start.lessonState).stepId ?? null;
    let target: bigint | null = null;
    let seen = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => finish(new Error(seen ? "The lesson stopped arriving. Try again." : "The tutor did not answer. Check that the worker is running, then try again.")), ms); };
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => {
      void feed.interrupt().catch(() => {});
      finish(signal?.reason instanceof Error ? signal.reason : new Error("Planning cancelled."));
    };
    const pump = () => {
      if (settled) return;
      try {
        const snap = feed.snapshot();
        if (target === null) {
          let next: bigint | null = null;
          for (const b of snap.beats) if (b.utteranceId > baseline && (next === null || b.utteranceId < next)) next = b.utteranceId;
          for (const t of snap.tutorTurns) if (t.utteranceId > baseline && (next === null || t.utteranceId < next)) next = t.utteranceId;
          if (next === null) return;
          target = next;
        }
        const rows = contiguousBeats(snap.beats, target);
        if (rows.length > seen) { seen = rows.length; arm(stallMs); }
        const notes = parseNotes(snap.lessonState);
        const accepted = rows.length > 0 && !!notes.stepId && notes.stepId !== baselineStep && notes.beatCount === rows.length;
        if (accepted) {
          const beats = rows.map(beatRowToVisual);
          const step = stepFromRows(snap.lessonState, beats);
          onProgress?.({ type: "blueprint", blueprint: { ...blueprintOf(step), open: true } });
          beats.forEach((beat, index) => onProgress?.({ type: "beat", index, beat }));
          finish(null, step);
          return;
        }
        const turn = snap.tutorTurns.find(t => t.utteranceId === target);
        const moved = snap.session !== undefined && snap.session.currentUtteranceId !== target && snap.session.currentUtteranceId !== 0n;
        if (turn || moved || (snap.session && !snap.session.active))
          throw new Error(!rows.length ? (turn?.interrupted ? "The explanation was interrupted before its picture." : "The tutor answered without a picture.")
            : turn?.interrupted ? "The explanation was interrupted." : "The tutor could not finish this lesson. Try again.");
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const unsubscribe = feed.subscribe(pump);
    signal?.addEventListener("abort", onAbort, { once: true });
    arm(firstBeatMs);
    const { trigger, key } = triggerFor(request, sent);
    sent.add(key);
    const call = trigger.kind === "start"
      ? (feed.snapshot().session?.turnCount ?? 0) === 0
        ? feed.startConversation()
        : feed.submitTextTurn(request.context.session.originalQuestion || request.context.session.topic, "")
      : trigger.kind === "text"
        ? feed.submitTextTurn(trigger.text, trigger.intent)
        : feed.submitInteraction(trigger.interaction, trigger.payload);
    call.then(pump, error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

// ---------------------------------------------------------------- generated-connection wrapper

type Cb = (...args: any[]) => void;
interface TableLike<R> {
  iter(): Iterable<R>;
  onInsert(cb: Cb): void;
  removeOnInsert(cb: Cb): void;
  onDelete(cb: Cb): void;
  removeOnDelete(cb: Cb): void;
  onUpdate?(cb: Cb): void;
  removeOnUpdate?(cb: Cb): void;
}
/** The parts of a generated `DbConnection` this adapter uses (structural, no bindings import). */
export interface SpacetimeConnectionLike {
  db: {
    beat: TableLike<BeatRowLike>;
    lessonState: TableLike<LessonStateLike>;
    turn: TableLike<TurnRowLike>;
    session: TableLike<SessionRowLike>;
  };
  reducers: {
    submitTextTurn(args: { sessionId: bigint; text: string; intent: string }): Promise<void>;
    submitInteraction(args: { sessionId: bigint; kind: string; payload: string }): Promise<void>;
    startConversation(args: { sessionId: bigint }): Promise<void>;
    interrupt(args: { sessionId: bigint }): Promise<void>;
  };
  subscriptionBuilder(): { onError(cb: Cb): unknown; subscribe(queries: string[]): { unsubscribe(): void } };
}

/** SQL for the rows the adapter reads (column names are the generated snake_case names). */
export const lessonFeedQueries = (sessionId: bigint) => [
  `SELECT * FROM beat WHERE session_id = ${sessionId}`,
  `SELECT * FROM lesson_state WHERE session_id = ${sessionId}`,
  `SELECT * FROM turn WHERE session_id = ${sessionId}`,
  `SELECT * FROM session WHERE id = ${sessionId}`,
];

export function connectionFeed(conn: SpacetimeConnectionLike, sessionId: bigint): LessonFeed & { close(): void } {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(l => l());
  const tables = [conn.db.beat, conn.db.lessonState, conn.db.turn, conn.db.session] as TableLike<unknown>[];
  for (const t of tables) { t.onInsert(notify); t.onDelete(notify); t.onUpdate?.(notify); }
  const builder = conn.subscriptionBuilder();
  builder.onError(() => {});
  const sub = builder.subscribe(lessonFeedQueries(sessionId));
  return {
    snapshot: () => ({
      beats: [...conn.db.beat.iter()].filter(b => b.sessionId === sessionId),
      tutorTurns: [...conn.db.turn.iter()].filter(t => t.sessionId === sessionId && t.role === "tutor" && t.utteranceId !== 0n),
      lessonState: [...conn.db.lessonState.iter()].find(s => s.sessionId === sessionId),
      session: [...conn.db.session.iter()].find(s => s.id === sessionId),
    }),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    submitTextTurn: (text, intent) => conn.reducers.submitTextTurn({ sessionId, text, intent }),
    submitInteraction: (kind, payload) => conn.reducers.submitInteraction({ sessionId, kind, payload }),
    startConversation: () => conn.reducers.startConversation({ sessionId }),
    interrupt: () => conn.reducers.interrupt({ sessionId }),
    close: () => {
      for (const t of tables) { t.removeOnInsert(notify); t.removeOnDelete(notify); t.removeOnUpdate?.(notify); }
      try { sub.unsubscribe(); } catch { /* already ended */ }
      listeners.clear();
    },
  };
}

/** The team's PlanningModel over SpacetimeDB (replaces createStreamingPlanningModel('/api/teaching/plan')). */
export function createSpacetimePlanningModel(conn: SpacetimeConnectionLike, sessionId: bigint, options?: SpacetimeModelOptions): PlanningModel & { close(): void } {
  const feed = connectionFeed(conn, sessionId);
  const model = createFeedPlanningModel(feed, options) as PlanningModel & { close(): void };
  model.close = feed.close;
  return model;
}
