import { geometryArea } from "../presentation/math/models";
import type { CanvasState } from "../presentation/contracts";
import { containerIds, objectIds } from "../shared/contracts";
import type { Evidence, LearnerResponse, TeachingCheck } from "./contracts";
import { NumericRuleSchema } from "./contracts";
import type { z } from "zod";
import { parseSpokenNumber } from "./numbers";

export function numericValue(rule: z.infer<typeof NumericRuleSchema>): number {
  switch (rule.operation) {
    case "value":
      return rule.value;
    case "sum":
      return rule.left + rule.right;
    case "difference":
      return rule.left - rule.right;
    case "product":
      return rule.left * rule.right;
    case "quotient":
      return rule.left / rule.right;
  }
}
function modelValue(
  check: Extract<TeachingCheck, { kind: "math_value" }>,
  canvas: CanvasState,
): number {
  const visual = canvas.math?.visual;
  if (!visual || visual.id !== check.visualId)
    throw new Error("Check refers to a missing math visual.");
  switch (check.field) {
    case "geometry_area":
      if (visual.kind === "geometry") return geometryArea(visual);
      break;
    case "geometry_width":
      if (visual.kind === "geometry") return visual.width;
      break;
    case "geometry_height":
      if (visual.kind === "geometry") return visual.height;
      break;
    case "array_total":
      if (visual.kind === "array") return visual.rows * visual.columns;
      break;
    case "array_rows":
      if (visual.kind === "array") return visual.rows;
      break;
    case "array_columns":
      if (visual.kind === "array") return visual.columns;
      break;
    case "bar_amount": {
      if (visual.kind !== "bars") break;
      const bar = visual.bars.find((x) => x.id === check.itemId);
      if (bar) return bar.shaded / bar.parts;
      break;
    }
    case "marker_value": {
      if (visual.kind !== "number_line") break;
      const marker = visual.markers.find((x) => x.id === check.itemId);
      if (marker) return marker.value;
      break;
    }
  }
  throw new Error("Check field/item does not match the visual.");
}
export function validateCheck(
  check: TeachingCheck | null,
  canvas: CanvasState,
) {
  if (!check) return;
  if (check.kind === "math_value") modelValue(check, canvas);
  if (check.kind === "placement" || check.kind === "order") {
    const scene = canvas.activity;
    if (!scene || scene.sceneId !== check.sceneId)
      throw new Error("Check refers to a missing activity.");
    const ids = objectIds(scene.activity);
    if (
      check.kind === "placement" &&
      !scene.activity.allowedInteractions.includes("place")
    )
      throw new Error("Placement check needs enabled placement controls.");
    if (
      check.kind === "order" &&
      !scene.activity.allowedInteractions.includes("reorder")
    )
      throw new Error("Order check needs enabled reorder controls.");
    if (
      check.kind === "placement" &&
      (!ids.includes(check.objectId) ||
        !containerIds(scene.activity).includes(check.containerId))
    )
      throw new Error("Check refers to an unknown object or container.");
    if (
      check.kind === "order" &&
      (ids.length !== check.objectIds.length ||
        check.objectIds.some((id) => !ids.includes(id)))
    )
      throw new Error(
        "Order check must include each activity object exactly once.",
      );
  }
}
type Observation = Pick<
  Evidence,
  "outcome" | "source" | "observation" | "observedValue"
>;
const unclear = (observation: string): Observation => ({
  outcome: "unclear",
  source: "unassessed",
  observation,
});
const numberEqual = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
export function assessResponse(
  check: TeachingCheck | null,
  response: LearnerResponse["response"],
  canvas: CanvasState,
): Observation {
  if (response.kind === "help")
    return {
      outcome: "not_assessed",
      source: "unassessed",
      observation: "Learner requested " + response.request + ".",
    };
  if (!check) return unclear("No check was attached to this step.");
  if (check.kind === "explanation")
    return unclear(
      "Explanation recorded; it needs a tentative interpretation against the rubric.",
    );
  let correct: boolean;
  let observedValue: number | string | string[];
  if (check.kind === "number") {
    if (response.kind !== "answer")
      return unclear("This check needs a numeric answer.");
    const parsed = parseSpokenNumber(response.text);
    if (parsed === null)
      return unclear(
        "Response is not an unambiguous number; clarify rather than mark it wrong.",
      );
    observedValue = parsed;
    if (!Number.isFinite(observedValue))
      return unclear("The number could not be read.");
    correct = numberEqual(observedValue, numericValue(check.rule));
  } else if (check.kind === "choice") {
    if (
      response.kind !== "choice" ||
      !check.options.some((o) => o.id === response.optionId)
    )
      return unclear("No recognized option was selected.");
    observedValue = response.optionId;
    correct = response.optionId === check.correctOptionId;
  } else {
    if (response.kind !== "interaction")
      return unclear(
        "This check needs the learner to submit the canvas state.",
      );
    validateCheck(check, canvas);
    if (check.kind === "math_value") {
      observedValue = modelValue(check, canvas);
      correct = numberEqual(observedValue, numericValue(check.rule));
    } else if (check.kind === "placement") {
      observedValue = canvas.activity!.placements[check.objectId] ?? "unplaced";
      correct = observedValue === check.containerId;
    } else {
      observedValue = [...canvas.activity!.order];
      correct = observedValue.every((id, i) => id === check.objectIds[i]);
    }
  }
  return {
    outcome: correct ? "correct" : "incorrect",
    source: "deterministic",
    observation: correct
      ? "Response matches the explicit checking rule."
      : "Response does not match the explicit checking rule.",
    observedValue,
  };
}
