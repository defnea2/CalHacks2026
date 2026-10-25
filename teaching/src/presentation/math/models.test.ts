import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "../canvasState";
import { emptyCanvas } from "../contracts";
import {
  MathVisualSchema,
  mathActivity,
  mathSummary,
  updateMathVisual,
} from "./models";

const array = MathVisualSchema.parse({
  id: "a",
  title: "An array",
  kind: "array",
  rows: 3,
  columns: 14,
});
describe("mathematical commands", () => {
  it("derives split products and updates the same model without mutating it", () => {
    const split = updateMathVisual(array, { type: "set_array", splitAt: 10 });
    expect(mathSummary(split)).toBe("3 × 14 = 3 × 10 + 3 × 4 = 30 + 12 = 42");
    const more = updateMathVisual(split, { type: "set_array", rows: 4 });
    expect(mathSummary(more)).toBe("4 × 14 = 4 × 10 + 4 × 4 = 40 + 16 = 56");
    expect(mathSummary(array)).toBe("3 × 14 = 42");
    expect(more.id).toBe(array.id);
  });
  it("rejects invalid splits, inconsistent patches, unknown focus, and incompatible operations", () => {
    expect(() =>
      updateMathVisual(array, { type: "set_array", splitAt: 14 }),
    ).toThrow();
    expect(() =>
      updateMathVisual(array, { type: "set_focus", target: "left" }),
    ).toThrow();
    expect(() =>
      updateMathVisual(array, { type: "move_marker", markerId: "a", value: 1 }),
    ).toThrow();
    expect(() => MathVisualSchema.parse({ ...array, columns: 200 })).toThrow();
  });
  it("validates a whole command batch atomically", () => {
    const current = applyCanvasCommands(emptyCanvas(), [
      { type: "show_math", visual: array },
    ]);
    expect(() =>
      applyCanvasCommands(current, [
        {
          type: "update_math",
          id: "a",
          change: { type: "set_array", rows: 4 },
        },
        {
          type: "update_math",
          id: "a",
          change: { type: "set_array", splitAt: 20 },
        },
      ]),
    ).toThrow();
    expect(current.math?.revision).toBe(0);
    expect(current.math?.visual).toEqual(array);
  });
  it("compares quantities exactly and adapts math to the existing interactive components", () => {
    const bars = MathVisualSchema.parse({
      id: "b",
      title: "Equivalent amounts",
      kind: "bars",
      interactive: true,
      bars: [
        { id: "half", label: "First", shaded: 1, parts: 2 },
        { id: "quarters", label: "Second", shaded: 2, parts: 4 },
      ],
    });
    expect(mathSummary(bars)).toBe("1/2 = 2/4 (equal wholes)");
    const scene = { visual: bars, revision: 5, appliedEventIds: [] };
    expect(mathActivity(scene, true)?.activity.allowedInteractions).toContain(
      "set_shaded",
    );
    expect(mathActivity(scene, false)?.activity.allowedInteractions).toEqual(
      [],
    );
    expect(mathActivity(scene, true)?.revision).toBe(5);
    expect(() =>
      updateMathVisual(bars, { type: "set_bar", barId: "half", shaded: 3 }),
    ).toThrow();
  });
  it("preserves bounded markers when the scale changes", () => {
    const line = MathVisualSchema.parse({
      id: "n",
      title: "Decimals",
      kind: "number_line",
      min: 0,
      max: 1,
      markers: [{ id: "p", label: "Point", value: 0.4 }],
    });
    expect(
      mathSummary(
        updateMathVisual(line, {
          type: "move_marker",
          markerId: "p",
          value: 0.35,
        }),
      ),
    ).toBe("Point: 0.35");
    expect(() =>
      updateMathVisual(line, { type: "set_range", min: 0.5, max: 1 }),
    ).toThrow();
    expect(() =>
      MathVisualSchema.parse({
        ...line,
        markers: [
          line.kind === "number_line" && line.markers[0],
          line.kind === "number_line" && line.markers[0],
        ],
      }),
    ).toThrow();
  });
});
