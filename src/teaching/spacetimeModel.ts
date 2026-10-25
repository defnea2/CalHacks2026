// SpacetimeDB planning adapter: the team's PlanningModel contract over SpacetimeDB rows.
//
// Trigger  = a reducer call (submitTextTurn with an intent, submitInteraction, startConversation).
// Response = the session's `beat` rows of the NEXT tutor utterance (one row per complete moment,
//            compiled + validated by the module), its step metadata from `lesson_state`, and its
//            end (the tutor `turn` row of that utterance). Abort = `interrupt`.
// See docs/CONTRACT-night.md section 1 and client/README.md "Team lesson over SpacetimeDB".
//
// Pure TypeScript: `LessonFeed` is the seam (unit tests use a fake; `connectionFeed` wraps a
// generated DbConnection structurally, so this file never imports client bindings).
import { z } from "zod";
import type { PlanningModel, PlanningRequest } from "./TeachingPlanner";
import { PhaseSchema, TeachingStepSchema, type TeachingStep } from "./contracts";
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

const StepMetaSchema = z.object(TeachingStepSchema.shape).omit({ beats: true }).partial();
type StepMeta = Omit<TeachingStep, "beats">;
const NotesSchema = z.object({ step: z.unknown().optional(), utteranceId: z.union([z.string(), z.number()]).optional(), error: z.string().optional() }).passthrough();

export function parseNotes(state: LessonStateLike | undefined): z.infer<typeof NotesSchema> {
  try { return NotesSchema.parse(JSON.parse(state?.notes || "{}")); } catch { return {}; }
}

/** Step metadata for an utterance: `lesson_state.notes.step` when the module provides it,
 *  otherwise derived from stage + checkPrompt (best effort, always schema-valid with the beats). */
export function stepMeta(state: LessonStateLike | undefined, utteranceId: bigint, lastNarration?: string): StepMeta {
  const fromNotes = StepMetaSchema.safeParse(parseNotes(state).step);
  const notes = fromNotes.success ? fromNotes.data : {};
  const stage = PhaseSchema.safeParse(notes.phase ?? state?.stage);
  const prompt = state?.checkPrompt?.trim() ?? "";
  let check = notes.check !== undefined ? notes.check : prompt ? { kind: "explanation" as const, prompt, rubric: ["Explains the idea in their own words."] } : null;
  // The final beat must speak the check; known only once the utterance is complete.
  if (check && lastNarration !== undefined && !lastNarration.includes(check.prompt)) check = null;
  let phase = stage.success ? stage.data : "intuition";
  if (!check && ["diagnose", "repair", "solo", "transfer"].includes(phase)) phase = "intuition";
  if (phase === "return_to_problem" && check) phase = "intuition";
  const needsExample = ["worked_example", "solo", "transfer"].includes(phase);
  return {
    id: notes.id ?? `step-${utteranceId}`,
    phase,
    learningGoal: notes.learningGoal ?? "Understand the idea in the picture.",
    approach: phase === "return_to_problem" ? "handoff" : notes.approach && notes.approach !== "handoff" ? notes.approach : "continue",
    rationale: notes.rationale ?? "Planned by the tutor.",
    ...(notes.exampleProblem || needsExample ? { exampleProblem: notes.exampleProblem ?? "The example in the picture." } : {}),
    check,
    evidenceToObserve: notes.evidenceToObserve ?? ["The learner's response to the picture."],
    assessment: notes.assessment ?? null,
  };
}

// ---------------------------------------------------------------- request → trigger

export type LessonTrigger =
  | { kind: "start" }
  | { kind: "text"; text: string; intent: LessonIntent }
  | { kind: "interaction"; interaction: string; payload: string; text: string };

/** Which reducer call a planning request stands for. `sent` holds the evidence/context ids
 *  already submitted by this model instance (a retry never duplicates a learner turn). */
export function triggerFor(request: PlanningRequest, sent: ReadonlySet<string>): { trigger: LessonTrigger; key: string } {
  const { context } = request;
  const latest = context.evidence.at(-1);
  if (latest && !sent.has(latest.eventId)) {
    const r = latest.response;
    const key = latest.eventId;
    if (r.kind === "answer") return { key, trigger: { kind: "text", text: r.text, intent: "" } };
    if (r.kind === "choice") {
      const check = context.currentStep?.check;
      const label = check?.kind === "choice" ? check.options.find(o => o.id === r.optionId)?.label : undefined;
      return { key, trigger: { kind: "text", text: label ?? r.optionId, intent: "" } };
    }
    if (r.kind === "interaction")
      return { key, trigger: { kind: "interaction", interaction: "check_picture", payload: JSON.stringify({ stepId: latest.stepId, canvas: context.canvas }), text: "Check my picture." } };
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

/** PlanningModel over a LessonFeed: trigger, then follow the next utterance's rows. */
export function createFeedPlanningModel(feed: LessonFeed, options: SpacetimeModelOptions = {}): PlanningModel {
  const sent = new Set<string>();
  const firstBeatMs = options.firstBeatTimeoutMs ?? 60_000;
  const stallMs = options.stallTimeoutMs ?? 30_000;
  return (request, signal, onProgress) => new Promise<unknown>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("Planning cancelled.")); return; }
    // Everything up to here belongs to earlier replies; the answer is the first newer utterance.
    const baseline = knownUtterances(feed.snapshot());
    let target: bigint | null = null;
    let emitted = 0;
    let meta: StepMeta | null = null;
    const beats: VisualBeat[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => finish(new Error(emitted ? "The lesson stopped arriving. Try again." : "The tutor did not answer. Check that the worker is running, then try again.")), ms); };
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
        const notes = parseNotes(snap.lessonState);
        if (notes.error && (notes.utteranceId === undefined || String(notes.utteranceId) === String(target)) && rows.length === 0)
          throw new Error(notes.error);
        while (emitted < rows.length) {
          const row = rows[emitted]!;
          const beat = beatRowToVisual(row);
          if (emitted === 0) {
            // Frozen at the first beat: the completed step must match the announced blueprint.
            meta = stepMeta(snap.lessonState, target);
            const opening = { ...meta, beats: [beat] } as TeachingStep;
            onProgress?.({ type: "blueprint", blueprint: { ...blueprintOf(opening), open: true } });
          }
          beats.push(beat);
          onProgress?.({ type: "beat", index: emitted, beat });
          emitted++;
          arm(stallMs);
        }
        const turn = snap.tutorTurns.find(t => t.utteranceId === target);
        const moved = snap.session !== undefined && snap.session.currentUtteranceId !== target && snap.session.currentUtteranceId !== 0n;
        if (turn || moved || (snap.session && !snap.session.active)) {
          if (!beats.length) throw new Error(turn?.interrupted ? "The explanation was interrupted before its picture." : "The tutor answered without a picture.");
          const all = contiguousBeats(snap.beats, target);
          if (all.length > emitted) return; // wait: late rows of a finished utterance
          const last = beats.at(-1)!.narration;
          // A check announced later than the first beat is honoured only if it is still consistent.
          const finalMeta = meta ?? stepMeta(snap.lessonState, target, last);
          finish(null, TeachingStepSchema.parse({ ...finalMeta, beats }));
        }
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
        : feed.submitInteraction(trigger.interaction, trigger.payload).then(() => feed.submitTextTurn(trigger.text, ""));
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
