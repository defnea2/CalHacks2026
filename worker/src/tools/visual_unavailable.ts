import { TOOL_NAMES } from '@tutor/shared';
import type { ToolModule } from './types';

export const VISUAL_UNAVAILABLE = "I don't have a reliable diagram for that yet. We can explore equal groups, fractions, number lines, or area.";
export const visualUnavailable: ToolModule = {
  name: TOOL_NAMES.visualUnavailable,
  kind: 'action',
  async handler(_args, ctx) {
    if (!ctx.narrate) throw new Error('A response was already narrated.');
    await ctx.transport.clearBoard({ sessionId: ctx.sessionId });
    await ctx.narrate([VISUAL_UNAVAILABLE]);
    return { text: 'Unsupported demonstration acknowledged. Wait for the learner.', narrated: true };
  },
};
