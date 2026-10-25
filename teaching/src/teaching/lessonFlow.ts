// The team's TeachingPlanner state machine as pure data transitions, plus the beat-by-beat lesson
// compiler. Lets the SpacetimeDB module own the authoritative lesson state (lesson_state) and
// validate every streamed moment against canvas_state with exactly the team's rules.
//
// Mapping to TeachingPlanner (src/teaching/TeachingPlanner.ts):
//   request()          -> buildModelRequest (+ parseModelRequest: allowedPhases, assessment options)
//   accept()           -> acceptStep (after finalizeLesson validated the streamed beats)
//   presented()        -> presented
//   interrupt()        -> interruptLesson
//   respond()          -> respond
//   recordUtterance()  -> recordUtterance
// Differences: no crypto/ids generated here (the caller passes ids), and a help request is accepted
// in any state with a step (the module already interrupted the presentation when the turn arrived).
import { z } from "zod";
import { SessionConfigSchema, type Evidence, type LearnerResponse, type SessionConfig, type TeachingStep } from "./contracts";
import { assessResponse } from "./checks";
import { validateTeachingStep } from "./validateStep";
import { parseModelRequest, validateModelStep, type ModelRequest } from "../server/planning";
import { compactBeat, lessonStep } from "../server/compactLesson";
import { declarative, fixAssessment, hoistFlags, meta as MetaSchema, moment as MomentSchema, sanitizeVisual, type Meta, type Moment } from "../server/streamingLesson";
import type { CanvasState, VisualBeat } from "../presentation/contracts";

export type LessonStatus = "needs_plan" | "presenting" | "awaiting_response" | "completed";
export interface LessonRecord {
  config: SessionConfig;
  status: LessonStatus;
  step: TeachingStep | null;
  history: TeachingStep[];
  evidence: Evidence[];
  revision: number;
}

export function newLessonRecord(config: unknown): LessonRecord {
  return { config: SessionConfigSchema.parse(config), status: "needs_plan", step: null, history: [], evidence: [], revision: 0 };
}
const bump = (r: LessonRecord, patch: Partial<LessonRecord>): LessonRecord => ({ ...r, ...patch, revision: r.revision + 1 });

export function latestEvidence(r: LessonRecord): Evidence | undefined {
  return r.evidence.filter(e => e.stepId === r.step?.id).at(-1);
}

/** The planner request for the current state (TeachingPlanner.request + parseModelRequest). */
export function buildModelRequest(r: LessonRecord, canvas: CanvasState, requestId: string): ModelRequest {
  return parseModelRequest({
    version: 1,
    requestId,
    basedOnRevision: r.revision,
    context: {
      session: r.config,
      currentStep: r.step,
      recentSteps: r.history.slice(-8),
      usedExampleProblems: r.history.flatMap(s => (s.exampleProblem ? [s.exampleProblem] : [])),
      evidence: r.evidence.slice(-20),
      canvas,
    },
  });
}

/** A learner response to the current step (TeachingPlanner.respond). Returns the new record and evidence item. */
export function respond(r: LessonRecord, eventId: string, response: LearnerResponse["response"], canvas: CanvasState): { record: LessonRecord; evidence: Evidence } {
  const step = r.step;
  if (!step) throw new Error("Start a lesson first.");
  if (response.kind !== "help" && r.status !== "awaiting_response") throw new Error("Response belongs to an inactive or unfinished teaching step.");
  if (r.evidence.some(e => e.eventId === eventId)) throw new Error("Event ID reused.");
  if (r.evidence.length >= 160) throw new Error("Session evidence limit reached; start a new session.");
  const item: Evidence = {
    eventId,
    stepId: step.id,
    phase: step.phase,
    learningGoal: step.learningGoal,
    prompt: step.check?.prompt ?? "",
    response,
    assistance: ["solo", "transfer"].includes(step.phase) && !["hint", "simplify"].includes(step.approach) ? "none" : "supported",
    ...assessResponse(step.check, response, canvas),
  };
  return { record: bump(r, { evidence: [...r.evidence, item], status: "needs_plan" }), evidence: item };
}

/** A typed or spoken answer. For a choice check, text naming exactly one option (its label, or
 *  "a"/"b"... its id) counts as choosing it: voice and text learners cannot click the option. */
export function answerResponse(check: TeachingStep["check"], text: string): LearnerResponse["response"] {
  if (check?.kind !== "choice") return { kind: "answer", text };
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}./]+/gu, " ").trim()} `;
  const said = norm(text);
  const byLabel = check.options.filter(o => said.includes(norm(o.label)));
  // Prefer the longest label ("0.45" also contains "0.4"); ignore ties.
  const longest = byLabel.sort((a, b) => b.label.length - a.label.length);
  if (longest.length === 1 || (longest.length > 1 && longest[0]!.label.length > longest[1]!.label.length && norm(longest[0]!.label).includes(norm(longest[1]!.label).trim())))
    return { kind: "choice", optionId: longest[0]!.id };
  const byId = check.options.filter(o => said.trim() === o.id.toLowerCase() || said.includes(` option ${o.id.toLowerCase()} `));
  if (byId.length === 1) return { kind: "choice", optionId: byId[0]!.id };
  return { kind: "answer", text };
}

/** Unscored learner context (an utterance that is not an answer). Never invents evidence. */
export function recordUtterance(r: LessonRecord, id: string, text: string): LessonRecord {
  const utterance = text.trim().slice(0, 2000);
  if (!utterance) return r;
  return bump(r, { config: { ...r.config, context: [...r.config.context.slice(-11), { id, text: utterance, source: "learner speech" }] } });
}

export function acceptStep(r: LessonRecord, step: TeachingStep, evidence: Evidence[]): LessonRecord {
  return bump(r, { step, evidence, history: [...r.history, step].slice(-80), status: "presenting" });
}

/** The whole step was presented (its last narration played). */
export function presented(r: LessonRecord): LessonRecord {
  if (r.status !== "presenting" || !r.step) return r;
  return bump(r, { status: r.step.phase === "return_to_problem" ? "completed" : r.step.check ? "awaiting_response" : "needs_plan" });
}

/** The presentation stopped early (barge-in, newer turn, failure). */
export function interruptLesson(r: LessonRecord): LessonRecord {
  return r.status === "presenting" ? bump(r, { status: "needs_plan" }) : r;
}

// ------------------------------------------------------------------ beat-by-beat compilation

/** Lesson meta as streamed (planned first), with the team's assessment repair. */
export function parseLessonMeta(request: ModelRequest, input: unknown): Meta {
  return fixAssessment(request, MetaSchema.parse(input));
}

/** addBeat's `visual` argument: a bare compact command ({kind,...}) or a moment without narration
 *  ({visual, interactive?, showEquation?, final?}). */
export interface StreamedBeatInput { moment: Moment; final: boolean }
export function parseBeatInput(meta: Meta, input: unknown, narration: string): StreamedBeatInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("visual must be a JSON object.");
  const o = input as Record<string, unknown>;
  const { final, ...rest } = "kind" in o ? { final: false, visual: o } : (o as { final?: unknown; [k: string]: unknown });
  const parsed = declarative(meta, MomentSchema.parse(hoistFlags({ ...rest, narration })));
  return { moment: { ...parsed, visual: sanitizeVisual(parsed.visual) }, final: final === true };
}

/** One moment compiled against the canvas planned so far (the final one may be interactive). */
export function compileMoment(meta: Meta, moment: Moment, index: number, final: boolean, planned: CanvasState): { beat: VisualBeat; planned: CanvasState } {
  const r = compactBeat(meta, moment, index, final, planned);
  return { beat: r.beat as VisualBeat, planned: r.planned };
}

/**
 * Validates the complete streamed lesson like the team's LessonStreamParser.finish(): the whole
 * step through validateModelStep (check prompt appended to the final narration once), with the
 * same approach relabel. Beats already spoken must stay exactly as they were.
 */
export function finalizeLesson(request: ModelRequest, meta: Meta, beats: VisualBeat[], record: LessonRecord): { step: TeachingStep; meta: Meta; evidence: Evidence[] } {
  let m = meta;
  for (let attempt = 0; ; attempt++) {
    try {
      const step = validateModelStep(request, lessonStep(m, beats, request.requestId));
      for (let i = 0; i < beats.length - 1; i++)
        if (JSON.stringify(step.beats[i]) !== JSON.stringify(beats[i])) throw new Error("Streamed beat differs from the validated lesson.");
      const { evidence } = validateTeachingStep(step, { config: record.config, step: record.step, history: record.history, evidence: record.evidence }, request.context.canvas as CanvasState, request.context.usedExampleProblems);
      return { step, meta: m, evidence };
    } catch (error) {
      if (attempt === 0 && error instanceof Error && /representation change must change/.test(error.message) && m.approach === "change_representation") {
        m = { ...m, approach: "simplify" };
        continue;
      }
      throw error;
    }
  }
}

/** Public view of a check: what the learner UI needs, never the answer. */
export function publicCheck(check: TeachingStep["check"]): Record<string, unknown> | null {
  if (!check) return null;
  switch (check.kind) {
    case "choice": return { kind: check.kind, prompt: check.prompt, options: check.options };
    case "math_value": return { kind: check.kind, prompt: check.prompt, visualId: check.visualId, field: check.field, ...(check.itemId ? { itemId: check.itemId } : {}) };
    case "placement": return { kind: check.kind, prompt: check.prompt, sceneId: check.sceneId, objectId: check.objectId };
    case "order": return { kind: check.kind, prompt: check.prompt, sceneId: check.sceneId };
    default: return { kind: check.kind, prompt: check.prompt };
  }
}

/** Validator message for the model's repair round (the team's formatting of zod issues). */
export function validatorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.slice(0, 8).map(i => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 2500);
  return error instanceof Error ? error.message : String(error);
}

export type { Meta as LessonMeta, Moment as LessonMoment };
