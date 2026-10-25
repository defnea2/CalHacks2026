import { z } from "zod";
import { readEventStream } from "../shared/eventStream";
import { LessonStreamParser } from "./streamingLesson";
import { ANTHROPIC_SYSTEM, DEFAULT_ANTHROPIC_MODEL, plannerUserMessage } from "../../teaching/src/server/plannerPrompt";
import type { ModelRequest } from "./planning";
import type { PlanningProgressHandler } from "../teaching/streaming";

export { DEFAULT_ANTHROPIC_MODEL, anthropicSchema, ANTHROPIC_SYSTEM } from "../../teaching/src/server/plannerPrompt";
export interface AnthropicOptions { apiKey?: string; model?: string; effort?: "low" | "medium" | "high"; fetcher?: typeof fetch }
const ProviderEvent = z.object({ type: z.string(), delta: z.object({ type: z.string().optional(), text: z.string().optional(), stop_reason: z.string().nullable().optional() }).optional() });

export function createAnthropicPlanner(options: AnthropicOptions = {}) {
  return async (request: ModelRequest, signal: AbortSignal, onProgress: PlanningProgressHandler = () => {}) => {
    if (!options.apiKey) throw new Error("Set ANTHROPIC_API_KEY on the server to enable generated lessons.");
    signal.throwIfAborted();
    let emitted = false;
    const progress: PlanningProgressHandler = event => { emitted = true; onProgress(event); };
    let repair: { output: string; error: string } | null = null;
    for (let attempt = 0; ; attempt++) {
      // No SDK auto-retries. A repair happens only for invalid output before anything was shown,
      // because a second generation cannot replace speech already heard.
      const response = await (options.fetcher ?? fetch)("https://api.anthropic.com/v1/messages", {
        method: "POST", signal,
        headers: { "Content-Type": "application/json", "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: options.model ?? DEFAULT_ANTHROPIC_MODEL, max_tokens: 4000, stream: true,
          // Adaptive thinking added ~8 s before the first token; the schema and validators carry the reasoning load.
          // The cached system block (>4k tokens) is read back on every later lesson.
          thinking: { type: "disabled" }, system: [{ type: "text", text: ANTHROPIC_SYSTEM, cache_control: { type: "ephemeral" } }], output_config: { effort: options.effort ?? "low" },
          messages: [{ role: "user", content: plannerUserMessage(request, repair) }],
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Never return raw provider diagnostics or credentials to the browser.
        throw new Error(response.status === 401 ? "Anthropic authentication failed. Check the server API key."
          : response.status === 429 ? "Anthropic is rate limited. Retry this lesson shortly."
          : `Anthropic planning failed (HTTP ${response.status}). Check model access and server configuration.`);
      }
      if (!response.body) throw new Error("Anthropic returned no stream.");
      const parser = new LessonStreamParser(request, progress);
      let stopped = false, reason: string | undefined, output = "";
      try {
        for await (const input of readEventStream(response.body, signal)) {
          const event = ProviderEvent.parse(input);
          if (event.type === "error") throw new ProviderStreamError("Anthropic stream failed. Retry the lesson.");
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") { output += event.delta.text ?? ""; parser.push(event.delta.text ?? ""); }
          if (event.type === "message_delta" && event.delta?.stop_reason) reason = event.delta.stop_reason;
          if (event.type === "message_stop") { stopped = true; break; }
        }
        signal.throwIfAborted();
        if (!stopped || reason !== "end_turn") throw new ProviderStreamError("Anthropic did not complete the lesson. Retry with a shorter question.");
        return parser.finish();
      } catch (error) {
        if (signal.aborted || error instanceof ProviderStreamError || emitted || attempt > 0) throw error;
        repair = { output, error: error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error) };
        await response.body.cancel().catch(() => {});
      }
    }
  };
}
class ProviderStreamError extends Error {}
