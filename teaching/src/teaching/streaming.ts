import { z } from "zod";
import { TeachingStepSchema, type TeachingStep } from "./contracts";
import { VisualBeatSchema, type VisualBeat } from "../presentation/contracts";

// A blueprint carries no speakable text. Only completed beat events may reach TTS.
export const LessonBlueprintSchema = z.object({
  ...TeachingStepSchema.shape,
  beats: z.array(z.object(VisualBeatSchema.shape).omit({ narration: true }).strict()).min(1).max(8),
  // While later moments are still generating: beats holds the visuals released so far and each following
  // `beat` event (index === beats.length) appends its visual. Absent once the blueprint is complete.
  open: z.literal(true).optional(),
}).strict();
export type LessonBlueprint = z.infer<typeof LessonBlueprintSchema>;
export const PlanningProgressSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("blueprint"), blueprint: LessonBlueprintSchema }).strict(),
  z.object({ type: z.literal("beat"), index: z.number().int().min(0).max(7), beat: VisualBeatSchema }).strict(),
]);
export type PlanningProgress = z.infer<typeof PlanningProgressSchema>;
export type PlanningProgressHandler = (event: PlanningProgress) => void;

/** Internal preflight only. Placeholder text is never emitted as a narration event. */
export function preflightStep(blueprint: LessonBlueprint): TeachingStep {
  return {
    ...blueprint,
    beats: blueprint.beats.map((beat, i) => ({ ...beat,
      narration: "Look at the picture." + (i === blueprint.beats.length - 1 && blueprint.check ? " " + blueprint.check.prompt : ""),
    })),
  };
}
export function blueprintOf(step: TeachingStep): LessonBlueprint {
  return { ...step, beats: step.beats.map(({ narration: _narration, ...beat }) => beat) };
}
/** Appends the next released beat's visual to an open blueprint. */
export function extendBlueprint(blueprint: LessonBlueprint, beat: VisualBeat): LessonBlueprint {
  const { narration: _narration, ...visual } = beat;
  return { ...blueprint, beats: [...blueprint.beats, visual] };
}
