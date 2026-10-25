import { TOOL_NAMES } from '@tutor/shared';
import { str, type ToolModule } from './types';

/** Query: stores the topic and returns library material + learner notes (JSON from the module). */
export const setTopic: ToolModule = {
  name: TOOL_NAMES.setTopic,
  kind: 'query',
  async handler(args, ctx) {
    return ctx.transport.setTopic({ sessionId: ctx.sessionId, category: str(args.category), concept: str(args.concept) });
  },
};
