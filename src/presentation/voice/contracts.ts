import { z } from 'zod';
import { CompactMathCommandSchema } from '../math/compact';

/** Offsets count actual sentences after the board tool, not estimated reading time. */
export const VoiceCanvasContentSchema = z.object({
  title: z.string().min(1).max(120),
  moments: z.array(z.object({
    sentenceOffset: z.number().int().min(0).max(7),
    visual: CompactMathCommandSchema,
    interactive: z.boolean().default(false),
    showEquation: z.boolean().default(false),
  }).strict()).min(1).max(4),
}).strict();
export type VoiceCanvasContent = z.input<typeof VoiceCanvasContentSchema>;
