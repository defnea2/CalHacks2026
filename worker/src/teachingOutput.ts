import type { LlmEvent, LlmProvider } from '@tutor/shared';

/** Tool rounds contain planning text; only a tool's authored narration is spoken.
 * Plain conversational replies are released when the round confirms it used no
 * tools. Tool calls themselves still stream immediately. This also keeps repair
 * commentary ("the board call failed") out of the child's audio and transcript. */
export function teachingOutput(provider: LlmProvider): LlmProvider {
  return {
    async *stream(opts): AsyncIterable<LlmEvent> {
      if (!opts.tools.length) { yield* provider.stream(opts); return; }
      let text = '';
      let usedTool = false;
      for await (const event of provider.stream(opts)) {
        if (opts.signal.aborted) return;
        if (event.type === 'text') {
          if (!usedTool) text += event.delta;
        } else if (event.type === 'tool_call') {
          usedTool = true;
          text = '';
          yield event;
        } else {
          if (!usedTool && text) yield { type: 'text', delta: text };
          text = '';
          yield event;
        }
      }
    },
  };
}
