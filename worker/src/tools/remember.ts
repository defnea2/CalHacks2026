import { TOOL_NAMES } from '@tutor/shared';
import { str, type ToolModule } from './types';

export const remember: ToolModule = {
  name: TOOL_NAMES.remember,
  kind: 'action',
  async handler(args, ctx) {
    await ctx.transport.remember({
      sessionId: ctx.sessionId,
      kind: str(args.kind),
      category: str(args.category),
      concept: str(args.concept),
      text: str(args.text),
      outcome: str(args.outcome),
    });
    return 'ok';
  },
};
