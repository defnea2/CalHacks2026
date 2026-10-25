import { z } from "zod";
import {
  IdSchema,
  ActivitySpecSchema,
  SceneCommandSchema,
  type SceneState,
} from "../shared";
import {
  MathVisualSchema,
  MathChangeSchema,
  type MathScene,
} from "./math/models";

export const ToneSchema = z.enum([
  "sky",
  "mint",
  "sun",
  "lilac",
  "coral",
  "ink",
]);
const CanvasNodeBaseSchema = z
  .object({
    id: IdSchema,
    kind: z.enum(["object", "label", "shape"]),
    x: z.number().min(0).max(1000),
    y: z.number().min(0).max(600),
    width: z.number().min(2).max(1000),
    height: z.number().min(2).max(600),
    label: z.string().max(120),
    icon: z
      .enum(["dot", "leaf", "sun", "cloud", "drop", "animal", "book"])
      .default("dot"),
    shape: z.enum(["circle", "rectangle", "triangle"]).default("rectangle"),
    tone: ToneSchema.default("sky"),
    rotation: z.number().min(-360).max(360).default(0),
  })
  .strict();
export const CanvasNodeSchema = CanvasNodeBaseSchema.superRefine((node, ctx) => {
  if (node.kind !== "shape" && (node.width < 20 || node.height < 20))
    ctx.addIssue({ code: "custom", message: "Objects and labels must be at least 20 by 20; only shapes may be thin." });
});
export type CanvasNode = z.infer<typeof CanvasNodeSchema>;
export type NodeInput = z.input<typeof CanvasNodeSchema>;
export const CanvasEdgeSchema = z
  .object({
    id: IdSchema,
    from: IdSchema,
    to: IdSchema,
    label: z.string().max(60).default(""),
    tone: ToneSchema.default("sky"),
  })
  .strict();
export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>;
// A patch must not reapply creation defaults to properties it did not mention.
const PatchSchema = CanvasNodeBaseSchema.omit({ id: true, kind: true })
  .extend({
    icon: CanvasNodeSchema.shape.icon.removeDefault(),
    shape: CanvasNodeSchema.shape.shape.removeDefault(),
    tone: CanvasNodeSchema.shape.tone.removeDefault(),
    rotation: CanvasNodeSchema.shape.rotation.removeDefault(),
  })
  .partial();
export const CanvasCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("show_math"), visual: MathVisualSchema }).strict(),
  z
    .object({
      type: z.literal("update_math"),
      id: IdSchema,
      change: MathChangeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("show_activity"),
      sceneId: IdSchema,
      activity: ActivitySpecSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("activity_command"),
      command: SceneCommandSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("clear"), title: z.string().min(1).max(120) })
    .strict(),
  z
    .object({
      type: z.literal("add"),
      nodes: z.array(CanvasNodeSchema).min(1).max(40),
    })
    .strict(),
  z
    .object({ type: z.literal("update"), id: IdSchema, patch: PatchSchema })
    .strict(),
  z
    .object({
      type: z.literal("remove"),
      ids: z.array(IdSchema).min(1).max(40),
    })
    .strict(),
  z
    .object({
      type: z.literal("connect"),
      edges: z.array(CanvasEdgeSchema).min(1).max(24),
    })
    .strict(),
  z
    .object({ type: z.literal("highlight"), ids: z.array(IdSchema).max(40) })
    .strict(),
  z
    .object({
      type: z.literal("point"),
      id: IdSchema.nullable(),
      label: z.string().max(80).default(""),
    })
    .strict(),
  z.object({ type: z.literal("note"), text: z.string().max(180) }).strict(),
]);
export type CanvasCommand = z.infer<typeof CanvasCommandSchema>;
export type CommandInput = z.input<typeof CanvasCommandSchema>;
export const VisualBeatSchema = z
  .object({
    id: IdSchema,
    narration: z.string().min(1).max(1600),
    cues: z
      .array(
        z
          .object({
            id: IdSchema,
            atMs: z.number().int().min(0).max(180000),
            commands: z.array(CanvasCommandSchema).min(1).max(50),
          })
          .strict(),
      )
      .max(40),
    question: z
      .object({
        prompt: z.string().min(1).max(200),
        nodeIds: z.array(IdSchema).min(1).max(12),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((beat, ctx) => {
    if (new Set(beat.cues.map((cue) => cue.id)).size !== beat.cues.length)
      ctx.addIssue({
        code: "custom",
        message: "Cue IDs must be unique within a beat.",
      });
    if (
      beat.cues.some(
        (cue, index) => index > 0 && cue.atMs < beat.cues[index - 1].atMs,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Cues must be in playback order.",
      });
  });
export type VisualBeat = z.infer<typeof VisualBeatSchema>;
export type BeatInput = z.input<typeof VisualBeatSchema>;
export interface CanvasState {
  title: string;
  math: MathScene | null;
  activity: SceneState | null;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  highlightedIds: string[];
  pointer: { id: string; label: string } | null;
  note: string;
}
export const emptyCanvas = (): CanvasState => ({
  title: "Let’s explore an idea",
  math: null,
  activity: null,
  nodes: [],
  edges: [],
  highlightedIds: [],
  pointer: null,
  note: "",
});
export interface PlaybackToken {
  runId: string;
  beatId: string;
}
export interface CanvasResponse extends PlaybackToken {
  type: "choose_node";
  nodeId: string;
}
