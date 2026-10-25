import { TOOL_NAMES } from '@tutor/shared';
import { str, type ToolModule } from './types';

export const setPhase: ToolModule = {
  name: TOOL_NAMES.setPhase,
  kind: 'action',
  async handler(args, ctx) {
    await ctx.transport.setPhase({ sessionId: ctx.sessionId, phase: str(args.phase), reason: str(args.reason) });
    return 'ok';
  },
};
