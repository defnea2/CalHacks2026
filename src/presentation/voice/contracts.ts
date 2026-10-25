import { z } from 'zod';
import { CompactMathCommandSchema } from '../math/compact';
import { TeachingIntentSchema } from '../math/teaching';

/** Offsets count actual sentences after the board tool, not estimated reading time. */
export const VoiceCanvasContentSchema = z.object({
  title: z.string().min(1).max(120),
  moments: z.array(z.object({
    sentenceOffset: z.number().int().min(0).max(7),
    /** Spoken once by the worker as the audio cue for this exact visual. */
    narration: z.string().trim().min(1).max(1200).optional(),
    /** Required for new generation; optional only to read historical recordings. */
    teaching: TeachingIntentSchema.optional(),
    visual: CompactMathCommandSchema,
    interactive: z.boolean().default(false),
    showEquation: z.boolean().default(false),
  }).strict()).min(1).max(4),
}).strict();
export type VoiceCanvasContent = z.input<typeof VoiceCanvasContentSchema>;
export const VoiceCanvasGenerationSchema = VoiceCanvasContentSchema.extend({
  moments: z.array(VoiceCanvasContentSchema.shape.moments.element.extend({ teaching: TeachingIntentSchema })).min(1).max(4),
});
