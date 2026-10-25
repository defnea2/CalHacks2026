import { LEARNER_QUESTIONS, TOOL_NAMES } from '@tutor/shared';
import type { ToolModule } from './types';

export const askLearner: ToolModule = {
  name: TOOL_NAMES.askLearner,
  kind: 'action',
  async handler(args, ctx) {
    if (!ctx.narrate) throw new Error('A response was already narrated.');
    const line = LEARNER_QUESTIONS[args.question as keyof typeof LEARNER_QUESTIONS];
    if (!line) throw new Error('Unknown conversational question.');
    await ctx.narrate([line]);
    return { text: 'Question delivered. Wait for the learner.', narrated: true };
  },
};
