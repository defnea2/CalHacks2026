import { TOOL_NAMES } from '@tutor/shared';
import type { ToolModule } from './types';

export const clearBoard: ToolModule = {
  name: TOOL_NAMES.clearBoard,
  kind: 'action',
  async handler(_args, ctx) {
    await ctx.transport.clearBoard({ sessionId: ctx.sessionId });
    return 'ok';
  },
};
