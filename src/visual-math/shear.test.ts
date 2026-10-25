import { describe, expect, it } from "vitest";
import {
  canCut, canDrag, createShearLesson, parallelogram, polygonArea, reassembled, reduceShearLesson,
  remainder, shapeArea, translate, wedge, wedgeOffset, type Point, type ShearLesson,
} from "./shear";

const sides = (p: Point[]) => p.map(([x, y], i) => { const [a, b] = p[(i + 1) % p.length]; return Math.hypot(a - x, b - y); }).sort();
const inside = (points: Point[], rect: Point[]) => points.every(([x, y]) => x >= rect[0][0] - 1e-9 && x <= rect[1][0] + 1e-9 && y >= 0 && y <= rect[2][1] + 1e-9);

describe("shear geometry", () => {
  it.each([0, 2.5, 6])("keeps base, height and area at shear %s", shear => {
    const shape = { base: 6, height: 4, shear };
    const p = parallelogram(shape);
    expect(p[1][0] - p[0][0]).toBe(6);
    expect(p[2][1] - p[1][1]).toBe(4);
    expect(polygonArea(p)).toBe(24);
    expect(shapeArea(shape)).toBe(24);
  });

  it.each([0.5, 3, 6])("reassembles the same wedge into the rectangle at shear %s", shear => {
    const shape = { base: 6, height: 4, shear };
    const piece = wedge(shape)!, moved = translate(piece, wedgeOffset(shape)), rect = reassembled(shape);
    // Translation only: identical side lengths, so no scaling or reshaping.
    expect(sides(moved)).toEqual(sides(piece));
    expect(polygonArea(moved)).toBe(polygonArea(piece));
    // Both pieces lie in the rectangle and their areas add to exactly its area: no gap, no overlap.
    expect(inside(moved, rect) && inside(remainder(shape), rect)).toBe(true);
    expect(polygonArea(remainder(shape)) + polygonArea(moved)).toBe(polygonArea(rect));
    expect(polygonArea(rect)).toBe(24);
  });

  it("has no wedge at zero shear", () => {
    expect(wedge({ base: 6, height: 4, shear: 0 })).toBeNull();
    expect(polygonArea(remainder({ base: 6, height: 4, shear: 0 }))).toBe(24);
  });
});

describe("shear lesson phases", () => {
  const run = (...events: Parameters<typeof reduceShearLesson>[1][]) =>
    events.reduce<ShearLesson>(reduceShearLesson, createShearLesson());

  it("requires a prediction before the shape can move", () => {
    const start = createShearLesson();
    expect(canDrag(start)).toBe(false);
    expect(reduceShearLesson(start, { type: "set_shear", shear: 3 })).toBe(start);
    const predicted = reduceShearLesson(start, { type: "predict", prediction: "bigger" });
    expect(predicted).toMatchObject({ phase: "exploration", prediction: "bigger" });
  });

  it("clamps and snaps shear, and records the learner's actions", () => {
    const l = run({ type: "predict", prediction: "same" }, { type: "set_shear", shear: 2.3 }, { type: "set_shear", shear: 99 }, { type: "set_shear", shear: -4 });
    expect(l.shape.shear).toBe(0);
    expect(l.largestShear).toBe(6);
    expect(l.adjustments).toBe(3);
  });

  it("cannot cut an unslanted rectangle", () => {
    const l = run({ type: "predict", prediction: "smaller" });
    expect(canCut(l)).toBe(false);
    expect(reduceShearLesson(l, { type: "cut" })).toBe(l);
  });

  it("freezes shear during the proof and restores it for another attempt", () => {
    const cut = run({ type: "predict", prediction: "bigger" }, { type: "set_shear", shear: 4 }, { type: "cut" });
    expect(reduceShearLesson(cut, { type: "set_shear", shear: 1 })).toBe(cut);
    const sliding = reduceShearLesson(cut, { type: "slide" });
    expect(reduceShearLesson(sliding, { type: "set_shear", shear: 1 })).toBe(sliding);
    const done = reduceShearLesson(sliding, { type: "settled" });
    expect(done).toMatchObject({ phase: "explanation", proofsWatched: 1 });
    expect(reduceShearLesson(done, { type: "replay" }).phase).toBe("cut");
    const again = reduceShearLesson(done, { type: "try_again" });
    expect(again).toMatchObject({ phase: "exploration", attempts: 2, prediction: "bigger" });
    expect(canDrag(again)).toBe(true);
  });

  it("reset restores a coherent initial scene and still advances the revision", () => {
    const l = run({ type: "predict", prediction: "bigger" }, { type: "set_shear", shear: 4 }, { type: "reset" });
    expect(l).toMatchObject({ phase: "prediction", prediction: null, shape: { shear: 0 }, adjustments: 0 });
    expect(l.revision).toBe(3);
  });
});
