export type Point = readonly [number, number];
export type ShearPhase = "prediction" | "exploration" | "cut" | "translation" | "explanation";
export type AreaPrediction = "bigger" | "smaller" | "same";

/** Fixed positive base and height; only the horizontal shear varies (0 <= shear <= base). */
export interface ShearShape { base: number; height: number; shear: number }

export const SHEAR_STEP = 0.5;
export const clampShear = (shape: Pick<ShearShape, "base">, shear: number) =>
  Math.max(0, Math.min(shape.base, Math.round(shear / SHEAR_STEP) * SHEAR_STEP));

export function polygonArea(points: readonly Point[]) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

export function parallelogram({ base: b, height: h, shear: s }: ShearShape): Point[] {
  return [[0, 0], [b, 0], [b + s, h], [s, h]];
}

/** The left wedge cut along the perpendicular height. Null at zero shear: there is nothing to cut. */
export function wedge({ height: h, shear: s }: ShearShape): Point[] | null {
  return s > 0 ? [[0, 0], [s, 0], [s, h]] : null;
}

/** What remains after the wedge is removed. At maximum shear it degenerates to a triangle. */
export function remainder({ base: b, height: h, shear: s }: ShearShape): Point[] {
  return s >= b ? [[b, 0], [b + s, h], [s, h]] : [[s, 0], [b, 0], [b + s, h], [s, h]];
}

/** The same wedge, moved (never resized) by the base length. */
export const wedgeOffset = (shape: ShearShape): Point => [shape.base, 0];
export const translate = (points: readonly Point[], [dx, dy]: Point): Point[] =>
  points.map(([x, y]) => [x + dx, y + dy]);

/** The rectangle [s, b + s] x [0, h] that the reassembled pieces fill. */
export function reassembled({ base: b, height: h, shear: s }: ShearShape): Point[] {
  return [[s, 0], [b + s, 0], [b + s, h], [s, h]];
}

export const shapeArea = (shape: ShearShape) => shape.base * shape.height;
export const slantedSide = ({ height, shear }: ShearShape) => Math.hypot(height, shear);

export interface ShearLesson {
  phase: ShearPhase;
  shape: ShearShape;
  prediction: AreaPrediction | null;
  /** Learner evidence the tutor receives; nothing here is inferred. */
  adjustments: number;
  largestShear: number;
  proofsWatched: number;
  attempts: number;
  /** Increments on every learner-visible change so stale tutor replies can be discarded. */
  revision: number;
}

export type ShearEvent =
  | { type: "predict"; prediction: AreaPrediction }
  | { type: "set_shear"; shear: number }
  | { type: "cut" }
  | { type: "slide" }
  | { type: "settled" }
  | { type: "replay" }
  | { type: "try_again" }
  | { type: "reset" };

export function createShearLesson(base = 6, height = 4): ShearLesson {
  if (!(base > 0 && height > 0)) throw new Error("Base and height must be positive.");
  return { phase: "prediction", shape: { base, height, shear: 0 }, prediction: null, adjustments: 0, largestShear: 0, proofsWatched: 0, attempts: 1, revision: 0 };
}

export const canDrag = (lesson: ShearLesson) => lesson.phase === "exploration";
export const canCut = (lesson: ShearLesson) => lesson.phase === "exploration" && lesson.shape.shear > 0;
export const areaRevealed = (lesson: ShearLesson) => lesson.phase === "explanation";

/** Illegal events return the same object, so callers can detect a no-op. */
export function reduceShearLesson(lesson: ShearLesson, event: ShearEvent): ShearLesson {
  const next = (patch: Partial<ShearLesson>): ShearLesson => ({ ...lesson, ...patch, revision: lesson.revision + 1 });
  switch (event.type) {
    case "predict":
      return lesson.phase === "prediction" ? next({ prediction: event.prediction, phase: "exploration" }) : lesson;
    case "set_shear": {
      if (!canDrag(lesson) || !Number.isFinite(event.shear)) return lesson;
      const shear = clampShear(lesson.shape, event.shear);
      if (shear === lesson.shape.shear) return lesson;
      return next({ shape: { ...lesson.shape, shear }, adjustments: lesson.adjustments + 1, largestShear: Math.max(lesson.largestShear, shear) });
    }
    case "cut": return canCut(lesson) ? next({ phase: "cut" }) : lesson;
    case "slide": return lesson.phase === "cut" ? next({ phase: "translation" }) : lesson;
    case "settled": return lesson.phase === "translation" ? next({ phase: "explanation", proofsWatched: lesson.proofsWatched + 1 }) : lesson;
    case "replay": return lesson.phase === "explanation" ? next({ phase: "cut" }) : lesson;
    case "try_again": return lesson.phase === "explanation" ? next({ phase: "exploration", attempts: lesson.attempts + 1 }) : lesson;
    case "reset": return { ...createShearLesson(lesson.shape.base, lesson.shape.height), revision: lesson.revision + 1 };
  }
}
