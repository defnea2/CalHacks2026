import { z } from "zod";
import { IdSchema } from "../shared/contracts";
import { VisualBeatSchema } from "../presentation/contracts";

export const TEACHING_VERSION = 1 as const;
import { PhaseSchema, type TeachingPhase } from "./phase";
import { LessonArcSchema } from "./arc";
export { PhaseSchema, type TeachingPhase } from "./phase";
const short = z.string().min(1).max(600);
export const SessionConfigSchema = z
  .object({
    sessionId: IdSchema,
    age: z.number().int().min(5).max(18).default(9),
    topic: z.string().min(1).max(1200),
    originalQuestion: z.string().max(2000).optional(),
    // Keep older step-at-a-time clients compatible; the learner UI opts into a
    // complete explanation before its first check.
    lessonStyle: z.enum(["mini_lesson", "step_by_step"]).optional(),
    // A rigid lesson arc from the lesson pack (e.g. the two-minute demo); absent = adaptive policy.
    arc: LessonArcSchema.optional(),
    context: z
      .array(
        z
          .object({
            id: IdSchema,
            text: z.string().min(1).max(3000),
            source: z.string().max(200),
          })
          .strict(),
      )
      .max(12)
      .default([]),
  })
  .strict();
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
const finite = z.number().finite().min(-1e6).max(1e6);
export const NumericRuleSchema = z
  .discriminatedUnion("operation", [
    z.object({ operation: z.literal("value"), value: finite }).strict(),
    z
      .object({
        operation: z.enum(["sum", "difference", "product", "quotient"]),
        left: finite,
        right: finite,
      })
      .strict(),
  ])
  .refine(
    (rule) => rule.operation !== "quotient" || rule.right !== 0,
    "Cannot divide by zero.",
  );
export const CheckSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("number"),
      prompt: short,
      rule: NumericRuleSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("choice"),
      prompt: short,
      options: z
        .array(z.object({ id: IdSchema, label: short }).strict())
        .min(2)
        .max(6),
      correctOptionId: IdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("explanation"),
      prompt: short,
      rubric: z.array(short).min(1).max(5),
    })
    .strict(),
  z
    .object({
      kind: z.literal("math_value"),
      prompt: short,
      visualId: IdSchema,
      field: z.enum([
        "geometry_area",
        "geometry_width",
        "geometry_height",
        "parallelogram_area",
        "parallelogram_shear",
        "array_total",
        "array_rows",
        "array_columns",
        "bar_amount",
        "marker_value",
      ]),
      itemId: IdSchema.optional(),
      rule: NumericRuleSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("placement"),
      prompt: short,
      sceneId: IdSchema,
      objectId: IdSchema,
      containerId: IdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("order"),
      prompt: short,
      sceneId: IdSchema,
      objectIds: z.array(IdSchema).min(2).max(12),
    })
    .strict(),
]);
export type TeachingCheck = z.infer<typeof CheckSchema>;
export const TeachingStepSchema = z
  .object({
    id: IdSchema,
    phase: PhaseSchema,
    learningGoal: short,
    approach: z.enum([
      "introduce",
      "continue",
      "simplify",
      "change_representation",
      "hint",
      "challenge",
      "handoff",
    ]),
    rationale: short,
    exampleProblem: short.optional(),
    beats: z.array(VisualBeatSchema).min(1).max(8),
    check: CheckSchema.nullable(),
    evidenceToObserve: z.array(short).min(1).max(5),
    assessment: z
      .object({
        evidenceId: IdSchema,
        judgement: z.enum(["supported", "misconception", "unclear"]),
        observation: short,
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((step, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (new Set(step.beats.map((b) => b.id)).size !== step.beats.length)
      fail("Beat IDs must be unique within a teaching step.");
    if (
      ["diagnose", "repair", "solo", "transfer"].includes(step.phase) &&
      !step.check
    )
      fail("This teaching phase needs a check for understanding.");
    if (
      step.phase === "return_to_problem" &&
      (step.check || step.approach !== "handoff")
    )
      fail(
        "Return-to-problem must be a handoff without another solved exercise.",
      );
    if (
      ["worked_example", "solo", "transfer"].includes(step.phase) &&
      !step.exampleProblem
    )
      fail("Provide the separate example problem for this phase.");
    if (step.beats.some((b) => b.question))
      fail(
        "Use the teaching check as the one response contract; omit VisualBeat.question.",
      );
    if (step.check && !step.beats.at(-1)!.narration.includes(step.check.prompt))
      fail("Speak the check prompt in the final beat.");
    if (step.check?.kind === "choice") {
      const ids = step.check.options.map((o) => o.id);
      if (
        new Set(ids).size !== ids.length ||
        !ids.includes(step.check.correctOptionId)
      )
        fail("Choice answers must reference unique, existing options.");
    }
    if (
      step.check?.kind === "order" &&
      new Set(step.check.objectIds).size !== step.check.objectIds.length
    )
      fail("Expected order cannot repeat objects.");
  });
export type TeachingStep = z.infer<typeof TeachingStepSchema>;
export type StepInput = z.input<typeof TeachingStepSchema>;
export const LearnerResponseSchema = z
  .object({
    eventId: IdSchema,
    stepId: IdSchema,
    response: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("answer"), text: z.string().max(2000) })
        .strict(),
      z.object({ kind: z.literal("choice"), optionId: IdSchema }).strict(),
      z.object({ kind: z.literal("interaction") }).strict(),
      z
        .object({
          kind: z.literal("help"),
          request: z.enum(["simpler", "another_way", "hint", "repeat", "explain"]),
        })
        .strict(),
    ]),
  })
  .strict();
export type LearnerResponse = z.infer<typeof LearnerResponseSchema>;
export type Outcome = "correct" | "incorrect" | "unclear" | "not_assessed";
export interface Evidence {
  eventId: string;
  stepId: string;
  phase: TeachingPhase;
  learningGoal: string;
  prompt: string;
  response: LearnerResponse["response"];
  outcome: Outcome;
  source: "deterministic" | "unassessed" | "model_tentative";
  observation: string;
  assistance: "none" | "supported";
  observedValue?: number | string | string[];
}
