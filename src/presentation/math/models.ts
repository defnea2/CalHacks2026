import { z } from "zod";
import { createScene, IdSchema, type SceneState } from "../../shared";
import { compareFractions } from "../../visual-math/fractions";

const title = z.string().min(1).max(120);
const common = {
  id: IdSchema,
  title,
  interactive: z.boolean().default(false),
  showEquation: z.boolean().default(false),
  focus: z.string().min(1).max(80).nullable().default(null),
};
const rows = z.number().int().min(1).max(12);
const columns = z.number().int().min(1).max(20);
const parts = z.number().int().min(1).max(12);
const dimension = z.number().min(1).max(12).multipleOf(0.5);
const bound = z.number().finite().min(-1000).max(1000);
const bar = z
  .object({
    id: IdSchema,
    label: title,
    parts,
    shaded: z.number().int().min(0).max(12),
  })
  .strict();
const marker = z.object({ id: IdSchema, label: title, value: bound }).strict();
export const MathVisualSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...common,
        kind: z.literal("array"),
        rows,
        columns,
        splitAt: z.number().int().min(1).max(19).nullable().default(null),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal("bars"),
        bars: z.array(bar).min(1).max(4),
      })
      .strict(),
    z.object({ ...common, kind: z.literal("geometry"),
      shape: z.enum(["rectangle", "right_triangle"]), width: dimension, height: dimension,
    }).strict(),
    z
      .object({
        ...common,
        kind: z.literal("number_line"),
        min: bound,
        max: bound,
        markers: z.array(marker).min(1).max(6),
      })
      .strict(),
  ])
  .superRefine((visual, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (visual.kind === "array") {
      if (visual.splitAt !== null && visual.splitAt >= visual.columns)
        fail("Split must be inside the array.");
      if (
        visual.focus !== null &&
        !["all", "left", "right"].includes(visual.focus)
      )
        fail("Array focus must be all, left, right, or null.");
      if (
        ["left", "right"].includes(visual.focus ?? "") &&
        visual.splitAt === null
      )
        fail("Split the array before focusing a part.");
    } else if (visual.kind === "geometry") {
      if (visual.focus !== null) fail("Geometry focus must be null.");
    } else {
      const items = visual.kind === "bars" ? visual.bars : visual.markers;
      if (new Set(items.map((x) => x.id)).size !== items.length)
        fail("Visual item IDs must be unique.");
      if (visual.focus !== null && !items.some((x) => x.id === visual.focus))
        fail("Focus refers to an unknown item.");
      if (visual.kind === "bars" && visual.bars.some((x) => x.shaded > x.parts))
        fail("Shading exceeds partition count.");
      if (visual.kind === "number_line") {
        if (visual.min >= visual.max)
          fail("Number line min must be less than max.");
        if (
          visual.markers.some(
            (x) => x.value < visual.min || x.value > visual.max,
          )
        )
          fail("Marker outside number line range.");
      }
    }
  });
export type MathVisual = z.infer<typeof MathVisualSchema>;
export type MathVisualInput = z.input<typeof MathVisualSchema>;
export const MathChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_geometry"), width: dimension.optional(), height: dimension.optional() }).strict(),
  z
    .object({
      type: z.literal("set_array"),
      rows: rows.optional(),
      columns: columns.optional(),
      splitAt: z.number().int().min(1).max(19).nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("set_bar"),
      barId: IdSchema,
      parts: parts.optional(),
      shaded: z.number().int().min(0).max(12).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("move_marker"),
      markerId: IdSchema,
      value: bound,
    })
    .strict(),
  z.object({ type: z.literal("set_range"), min: bound, max: bound }).strict(),
  z
    .object({
      type: z.literal("set_focus"),
      target: z.string().min(1).max(80).nullable(),
    })
    .strict(),
  z
    .object({ type: z.literal("set_interaction"), enabled: z.boolean() })
    .strict(),
  z.object({ type: z.literal("set_equation"), visible: z.boolean() }).strict(),
]);
export type MathChange = z.infer<typeof MathChangeSchema>;
export interface MathScene {
  visual: MathVisual;
  revision: number;
  appliedEventIds: string[];
}
export const MathActionSchema = z
  .object({
    eventId: IdSchema,
    visualId: IdSchema,
    revision: z.number().int().nonnegative(),
    change: MathChangeSchema,
  })
  .strict();
export type MathAction = z.infer<typeof MathActionSchema>;

export function updateMathVisual(
  current: MathVisual,
  input: unknown,
): MathVisual {
  const change = MathChangeSchema.parse(input);
  const next = structuredClone(current);
  const mismatch = () => {
    throw new Error(`Cannot ${change.type} on ${current.kind}.`);
  };
  switch (change.type) {
    case "set_geometry": {
      if (next.kind !== "geometry") return mismatch();
      if (change.width !== undefined) next.width = change.width;
      if (change.height !== undefined) next.height = change.height;
      break;
    }
    case "set_array": {
      if (next.kind !== "array") return mismatch();
      const { type: _type, ...patch } = change;
      Object.assign(next, patch);
      break;
    }
    case "set_bar": {
      if (next.kind !== "bars") return mismatch();
      const item = next.bars.find((x) => x.id === change.barId);
      if (!item) throw new Error("Unknown bar.");
      if (change.parts !== undefined) item.parts = change.parts;
      if (change.shaded !== undefined) item.shaded = change.shaded;
      break;
    }
    case "move_marker": {
      if (next.kind !== "number_line") return mismatch();
      const item = next.markers.find((x) => x.id === change.markerId);
      if (!item) throw new Error("Unknown marker.");
      item.value = change.value;
      break;
    }
    case "set_range":
      if (next.kind !== "number_line") return mismatch();
      next.min = change.min;
      next.max = change.max;
      break;
    case "set_focus":
      next.focus = change.target;
      break;
    case "set_interaction":
      next.interactive = change.enabled;
      break;
    case "set_equation":
      next.showEquation = change.visible;
      break;
  }
  return MathVisualSchema.parse(next);
}

/** Values come from the model, never a second model-generated answer string. */
export function mathSummary(visual: MathVisual): string {
  if (visual.kind === "geometry") return `Area = ${visual.width} × ${visual.height}${visual.shape === "right_triangle" ? " ÷ 2" : ""} = ${geometryArea(visual)} square units`;
  if (visual.kind === "array") {
    const { rows: r, columns: c, splitAt: s } = visual;
    return s === null
      ? `${r} × ${c} = ${r * c}`
      : `${r} × ${c} = ${r} × ${s} + ${r} × ${c - s} = ${r * s} + ${r * (c - s)} = ${r * c}`;
  }
  if (visual.kind === "number_line")
    return visual.markers.map((x) => `${x.label}: ${x.value}`).join(" · ");
  const [a, b] = visual.bars;
  if (!b) return `${a.shaded}/${a.parts}`;
  const comparison = compareFractions(a.shaded, a.parts, b.shaded, b.parts);
  return `${a.shaded}/${a.parts} ${comparison === 0 ? "=" : comparison < 0 ? "<" : ">"} ${b.shaded}/${b.parts} (equal wholes)`;
}

/** Adapter reuses the tested bars and number-line interactions on the teaching surface. */
export function mathActivity(
  scene: MathScene,
  enabled: boolean,
): SceneState | null {
  const v = scene.visual;
  if (v.kind === "array" || v.kind === "geometry") return null;
  const result = createScene(
    {
      id: v.id,
      title: v.title,
      prompt: "Watch the representation, then explore when invited.",
      learningGoal: "Explore the mathematical representation.",
      kind: "bars_number_line",
      mode: v.kind === "bars" ? "bars" : "number_line",
      bars: v.kind === "bars" ? v.bars : [],
      markers: v.kind === "number_line" ? v.markers : [],
      min: v.kind === "number_line" ? v.min : 0,
      max: v.kind === "number_line" ? v.max : 1,
      allowedInteractions:
        enabled && v.interactive
          ? v.kind === "bars"
            ? ["set_parts", "set_shaded"]
            : ["move_marker"]
          : [],
    },
    v.id,
  );
  result.revision = scene.revision;
  result.highlightedIds = v.focus ? [v.focus] : [];
  return result;
}

export function geometryArea(v: Extract<MathVisual, { kind: "geometry" }>) {
  return v.width * v.height / (v.shape === "right_triangle" ? 2 : 1);
}
