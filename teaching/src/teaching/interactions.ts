// Learner manipulations of the shared canvas, as a pure transition function. Same rules as the
// team's VisualDirector.interactMath / interactActivity (client), so the SpacetimeDB module can
// validate a `submitInteraction` against `canvas_state` authoritatively.
import { LearnerActionSchema } from "../shared/contracts";
import { applySceneCommand, commandFromAction } from "../session/sceneReducer";
import { MathActionSchema, updateMathVisual } from "../presentation/math/models";
import type { CanvasState } from "../presentation/contracts";

export type InteractionResult = { ok: true; canvas: CanvasState; observation: string } | { ok: false; error: string };

/** Learners can manipulate quantities, but cannot grant themselves controls or reveal equations. */
const LEARNER_MATH_CHANGES = ["set_array", "set_bar", "move_marker", "set_geometry", "set_parallelogram"];

export function applyLearnerMathAction(canvas: CanvasState, input: unknown): InteractionResult {
  const parsed = MathActionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid math action." };
  const scene = canvas.math;
  if (!scene) return { ok: false, error: "There is no math picture to change." };
  if (!scene.visual.interactive) return { ok: false, error: "The picture is not interactive right now." };
  const action = parsed.data;
  if (action.visualId !== scene.visual.id) return { ok: false, error: "The action refers to another picture." };
  if (action.revision !== scene.revision) return { ok: false, error: `Stale picture revision ${action.revision} (current ${scene.revision}).` };
  if (scene.appliedEventIds.includes(action.eventId)) return { ok: false, error: "Duplicate learner event." };
  if (!LEARNER_MATH_CHANGES.includes(action.change.type)) return { ok: false, error: `Learners cannot ${action.change.type}.` };
  // A learner may only slant the uncut shape; the tutor owns base, height and the proof stages.
  if (action.change.type === "set_parallelogram" && (scene.visual.kind !== "parallelogram" || scene.visual.stage !== "slant"
    || Object.entries(action.change).some(([key, value]) => key !== "type" && key !== "shear" && value !== undefined)))
    return { ok: false, error: "Only the slant of the uncut shape can be changed." };
  try {
    const visual = updateMathVisual(scene.visual, action.change);
    const math = { visual, revision: scene.revision + 1, appliedEventIds: [...scene.appliedEventIds, action.eventId].slice(-1000) };
    return { ok: true, canvas: { ...canvas, math }, observation: `Learner changed the picture: ${JSON.stringify(action.change)}.` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid change." };
  }
}

export function applyLearnerActivityAction(canvas: CanvasState, input: unknown): InteractionResult {
  const parsed = LearnerActionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid activity action." };
  if (!canvas.activity) return { ok: false, error: "There is no activity to change." };
  const result = applySceneCommand(canvas.activity, commandFromAction(parsed.data));
  if (!result.ok) return { ok: false, error: result.message };
  if (result.status === "already_applied") return { ok: false, error: "Duplicate learner event." };
  return { ok: true, canvas: { ...canvas, activity: result.scene }, observation: `Learner action ${parsed.data.payload.type} in the activity.` };
}
