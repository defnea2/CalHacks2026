import { z } from "zod";
import type { CanvasState, CommandInput } from "../contracts";
import { MathChangeSchema, MathVisualSchema } from "./models";

// The wire vocabulary describes quantities, never pixels, colors, code or TeX.
const [array, bars, geometry, parallelogram, line] = MathVisualSchema.options;
const strip = { id: true, title: true, interactive: true, showEquation: true, focus: true } as const;
export const CompactMathCommandSchema = z.discriminatedUnion("kind", [
  array.omit(strip), bars.omit(strip), geometry.omit(strip), parallelogram.omit(strip), line.omit(strip),
  z.object({ kind: z.literal("update"), changes: z.array(MathChangeSchema).min(1).max(6) }).strict(),
  z.object({ kind: z.literal("keep") }).strict(),
]);
export type CompactMathCommand = z.input<typeof CompactMathCommandSchema>;
export function compileMathCommand(input: unknown, canvas: CanvasState, options: {
  title: string; interactive: boolean; showEquation: boolean;
}): CommandInput[] {
  const command = CompactMathCommandSchema.parse(input);
  if (command.kind === "keep" || command.kind === "update") {
    if (!canvas.math) throw new Error("Show a math representation before updating or keeping it.");
    const id = canvas.math.visual.id;
    return [
      ...(command.kind === "update" ? command.changes.map(change => ({ type: "update_math" as const, id, change })) : []),
      { type: "update_math", id, change: { type: "set_interaction", enabled: options.interactive } },
      { type: "update_math", id, change: { type: "set_equation", visible: options.showEquation } },
    ];
  }
  return [{ type: "show_math", visual: MathVisualSchema.parse({ ...command, title: options.title, interactive: options.interactive, showEquation: options.showEquation, id: "math", focus: null }) }];
}
