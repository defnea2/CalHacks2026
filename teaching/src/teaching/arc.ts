// Lesson arcs: a rigid sequence of lesson steps with a time budget (e.g. the two-minute demo arc
// of the lesson pack). The arc DATA lives in the lesson pack (shared/src/lesson/pack/arcs.ts) and
// travels in SessionConfig.arc, so the team policy (allowedPhases), the validators and the module
// all see the same rules. This file only interprets it:
//
//   arcPhases     -> the next allowed phases (replaces the adaptive policy while an arc is set)
//   arcStageFor   -> the stage a phase belongs to (moment limits, formalization slot, words)
//   arcMoment     -> per-moment enforcement in addBeat (formalization slot, moment cap)
//   arcPrompt     -> the cache-stable system prompt block for the arc
//   arcBudget     -> worst-case seconds of audio until explanation, formalization and task
import { z } from "zod";
import { PhaseSchema, type TeachingPhase } from "./phase";
import type { Evidence, LearnerDecision, TeachingStep } from "./contracts";

const phases = z.array(PhaseSchema).max(8);
export const ArcStageSchema = z
  .object({
    id: z.string().min(1).max(40),
    /** Phases a step of this stage may use (the first is the default). */
    phases: phases.min(1),
    /** Moment count of the step (validated; the module rejects a moment beyond maxMoments). */
    minMoments: z.number().int().min(1).max(8),
    maxMoments: z.number().int().min(1).max(8),
    /** Spoken words of the whole step (prompted; measured). */
    maxWords: z.number().int().min(10).max(400),
    /** Moment index whose equation is shown (the formalization keyframe); -1 = none. */
    formalizeAt: z.number().int().min(-1).max(7).default(-1),
    /** The step ends with a check (task) for the learner. */
    check: z.boolean(),
    /** Preferred check kinds (prompted). */
    checkKinds: z.array(z.enum(["choice", "number", "explanation", "math_value"])).max(4).default([]),
    /** Next allowed phases after this stage's step, by learner evidence. */
    next: z.object({ correct: phases, other: phases, help: phases }).strict(),
    /** Instructions for the model while planning this stage (pack prose). */
    guide: z.string().min(1).max(900),
  })
  .strict();
export const LessonArcSchema = z
  .object({
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(80),
    /** Target: explanation, formalization and task shown within this many seconds of audio. */
    budgetSeconds: z.number().int().min(10).max(900),
    /** Speaking rate used for the budget (TTS words per second). */
    wordsPerSecond: z.number().min(1).max(5),
    /** Allowed phases of the first step. */
    start: phases.min(1),
    /** Allowed phases when the current step's phase is in no stage. */
    fallback: phases,
    stages: z.array(ArcStageSchema).min(1).max(8),
    /** Allowed phases after the learner confirmed a significant change (intent.ts); `resume` = the current stage again. */
    decisions: z.object({ give_answer: phases, task_now: phases, hand_back: phases }).strict().optional(),
    /** Arc-wide instructions (system prompt, cache-stable). */
    guide: z.string().min(1).max(2000),
  })
  .strict();
export type ArcStage = z.infer<typeof ArcStageSchema>;
export type LessonArc = z.infer<typeof LessonArcSchema>;
export type LessonArcInput = z.input<typeof LessonArcSchema>;

export function arcStageFor(arc: LessonArc, phase: TeachingPhase): ArcStage | undefined {
  return arc.stages.find(s => s.phases.includes(phase));
}

/** Next allowed phases under the arc (deterministic; evidence picks the branch). */
export function arcPhases(arc: LessonArc, current: TeachingStep | null, evidence: Evidence | undefined, decision?: LearnerDecision): TeachingPhase[] {
  if (decision === "resume") return current ? (arcStageFor(arc, current.phase)?.phases ?? arc.fallback) : arc.start;
  if (decision && arc.decisions) return arc.decisions[decision];
  if (!current) return arc.start;
  const stage = arcStageFor(arc, current.phase);
  if (!stage) return arc.fallback;
  if (evidence?.response.kind === "help") return stage.next.help;
  // No evidence: the step had no check, or it was cut short / skipped ("continue").
  if (!evidence) return current.check ? stage.next.other : stage.next.correct;
  return evidence.outcome === "correct" ? stage.next.correct : stage.next.other;
}

/** The stage the next step will be planned in (first allowed phase). */
export function upcomingStage(arc: LessonArc, allowed: readonly TeachingPhase[]): ArcStage | undefined {
  return allowed.length ? arcStageFor(arc, allowed[0]!) : undefined;
}

/** Compact stage summary for the planner data (the full arc stays in the cached system prompt). */
export function stageBrief(stage: ArcStage) {
  return {
    stage: stage.id, phases: stage.phases, moments: stage.minMoments === stage.maxMoments ? stage.minMoments : `${stage.minMoments}-${stage.maxMoments}`,
    maxWords: stage.maxWords, wordsPerMoment: Math.round(stage.maxWords / stage.maxMoments), formalizeAtMoment: stage.formalizeAt >= 0 ? stage.formalizeAt + 1 : null,
    check: stage.check ? stage.checkKinds.join(" or ") || "any" : "none",
  };
}

/**
 * Per-moment arc rules, applied by the module before it compiles a streamed moment:
 * - the formalization slot shows the equation (code owns it: the picture gets its notation exactly there);
 * - a stage's step may not grow past maxMoments: moment maxMoments-1 must be the final one.
 * Returns the adjusted moment flags or throws the validator message.
 */
export function arcMoment(arc: LessonArc | undefined, phase: TeachingPhase, index: number, final: boolean, moment: { showEquation: boolean }): { showEquation: boolean } {
  const stage = arc && arcStageFor(arc, phase);
  if (!stage) return moment;
  if (!final && index >= stage.maxMoments - 1)
    throw new Error(`This lesson stage (${stage.id}) has at most ${stage.maxMoments} moments; moment ${index + 1} must be the final one.`);
  if (!final && index === stage.formalizeAt) return { ...moment, showEquation: true };
  return moment;
}

/** Arc-wide minimum moments / check requirement (replaces the mini-lesson heuristic while an arc is set). */
export function arcStepRules(arc: LessonArc, phase: TeachingPhase): { minimum: number; check: boolean } | null {
  const stage = arcStageFor(arc, phase);
  return stage ? { minimum: stage.minMoments, check: stage.check } : null;
}

/** System prompt block (stable per arc: cached with the rest of the system prompt). */
export function arcPrompt(arc: LessonArc): string {
  const stages = arc.stages.map((s, i) => {
    const b = stageBrief(s);
    return `${i + 1}. ${s.id} [phase ${s.phases.join(" or ")}; ${b.moments} moments; at most ${s.maxWords} spoken words in total, about ${b.wordsPerMoment} per moment: count them${b.formalizeAtMoment ? `; moment ${b.formalizeAtMoment} is the formalization (code shows the equation there)` : ""}; check: ${b.check}]: ${s.guide}`;
  });
  return `LESSON ARC "${arc.id}" (${arc.label}). It OVERRIDES the moment counts, word counts and phase advice above; the data field arcStage names the stage to plan now.
${arc.guide}
Stages:
${stages.join("\n")}`;
}

/**
 * Worst-case audio seconds (no learner speech counted) until the explanation, the formalization
 * and the task have each been spoken, along the arc's first step. `explanation` = the end of the
 * first moment, `formalization` = the end of the formalization moment, `task` = the end of the
 * step (the check is spoken in the final moment). Words are spread evenly over the moments.
 */
export function arcBudget(arc: LessonArc, openingSeconds = 0): { explanation: number; formalization: number | null; task: number; withinBudget: boolean } {
  const first = arcStageFor(arc, arc.start[0]!);
  if (!first) throw new Error(`Arc ${arc.id}: the start phase belongs to no stage.`);
  const perMoment = first.maxWords / first.maxMoments / arc.wordsPerSecond;
  const explanation = openingSeconds + perMoment;
  const formalization = first.formalizeAt >= 0 ? openingSeconds + perMoment * (first.formalizeAt + 1) : null;
  const task = openingSeconds + first.maxWords / arc.wordsPerSecond;
  return { explanation, formalization, task, withinBudget: task <= arc.budgetSeconds && first.check && formalization !== null };
}
