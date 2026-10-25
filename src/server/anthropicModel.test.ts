// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createAnthropicPlanner } from "./anthropicModel";
import { TeachingPlanner } from "../teaching/TeachingPlanner";
import { emptyCanvas } from "../presentation/contracts";
import { parseModelRequest } from "./planning";
import type { PlanningProgress } from "../teaching/streaming";

const lesson = { meta: { phase: "diagnose", title: "Groups", goal: "Understand groups", approach: "introduce", reason: "Predict a total", assessment: null,
  check: { kind: "number", prompt: "How many squares are there?", rule: { operation: "product", left: 2, right: 3 } },
}, moments: [{ visual: { kind: "array", rows: 2, columns: 3 }, interactive: false, showEquation: false, narration: "Look at the rows of squares." }] };
const request = () => parseModelRequest(new TeachingPlanner({ sessionId: "api-test", topic: "Groups" }).request(emptyCanvas()));
const sse = (event: unknown) => `data: ${JSON.stringify(event)}\r\n\r\n`;
function providerResponse(reason = "end_turn", stop = true) {
  return new Response(sse({ type: "content_block_delta", delta: { type: "text_delta", text: JSON.stringify(lesson) } })
    + sse({ type: "message_delta", delta: { stop_reason: reason } })
    + (stop ? sse({ type: "message_stop" }) : ""), { headers: { "Content-Type": "text/event-stream" } });
}
describe("Anthropic streaming planner", () => {
  it("uses server credentials and structured output without a CLI or browser schema", async () => {
    const fetcher = vi.fn().mockResolvedValue(providerResponse());
    const events: PlanningProgress[] = [];
    const signal = new AbortController().signal;
    const result = await createAnthropicPlanner({ apiKey: "server-secret", fetcher })(request(), signal, e => events.push(e));
    expect(result.beats[0].narration).toContain(lesson.meta.check.prompt);
    expect(events.map(e => e.type)).toEqual(["blueprint", "beat"]);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.signal).toBe(signal);
    expect(init.headers["x-api-key"]).toBe("server-secret");
    const payload = JSON.parse(init.body);
    expect(payload.model).toBe("claude-haiku-5-5");
    expect(payload.stream).toBe(true);
    expect(payload.output_config.effort).toBe("low");
    // Thinking adds seconds before the first token; the system block carries the cache breakpoint.
    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload.cache_control).toBeUndefined();
    expect(payload.system[0].cache_control).toEqual({ type: "ephemeral" });
    // The full lesson grammar exceeds structured-output limits; the schema travels as instructions.
    expect(payload.output_config.format).toBeUndefined();
    expect(payload.system[0].text).toContain('kind:"parallelogram"');
    expect(payload.system[0].text).toContain('base:number[1..8] step 0.5');
    expect(payload.system[0].text).not.toContain('"additionalProperties"');
    expect(JSON.stringify(payload)).not.toContain("server-secret");
    expect(payload.messages[0].content).not.toContain("responseSchema");
  });
  it("repairs invalid output once, but only before anything was shown", async () => {
    const invalid = () => new Response(sse({ type: "content_block_delta", delta: { type: "text_delta", text: '{"meta": {"phase": "nope"}, "moments": []}' } })
      + sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }) + sse({ type: "message_stop" }), { headers: { "Content-Type": "text/event-stream" } });
    const fetcher = vi.fn().mockResolvedValueOnce(invalid()).mockResolvedValueOnce(providerResponse());
    const step = await createAnthropicPlanner({ apiKey: "k", fetcher })(request(), new AbortController().signal);
    expect(step.beats).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).messages[0].content).toContain("rejected by the validator");
    const twice = vi.fn().mockResolvedValueOnce(invalid()).mockResolvedValueOnce(invalid());
    await expect(createAnthropicPlanner({ apiKey: "k", fetcher: twice })(request(), new AbortController().signal)).rejects.toThrow();
    expect(twice).toHaveBeenCalledTimes(2);
  });
  it("never releases the final question for truncation, refusal or missing completion", async () => {
    for (const [reason, stop] of [["max_tokens", true], ["refusal", true], ["end_turn", false]] as const) {
      const emit = vi.fn();
      const planner = createAnthropicPlanner({ apiKey: "key", fetcher: vi.fn().mockResolvedValue(providerResponse(reason, stop)) });
      await expect(planner(request(), new AbortController().signal, emit)).rejects.toThrow("did not complete");
      expect(emit.mock.calls.some(([e]) => e.type === "beat")).toBe(false);
    }
  });
  it("does not leak provider errors, retry rate limits, or call without a key", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("private provider detail", { status: 429 }));
    await expect(createAnthropicPlanner({ apiKey: "key", fetcher })(request(), new AbortController().signal)).rejects.toThrow("rate limited");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(createAnthropicPlanner({ fetcher })(request(), new AbortController().signal)).rejects.toThrow("ANTHROPIC_API_KEY");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("cancels a pending stream read immediately", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const controller = new AbortController();
    const result = createAnthropicPlanner({ apiKey: "key", fetcher: vi.fn().mockResolvedValue(new Response(body)) })(request(), controller.signal);
    const assertion = expect(result).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort(); await assertion;
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
