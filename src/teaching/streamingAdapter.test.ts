// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createStreamingPlanningModel } from "./modelAdapter";
import { TeachingPlanner } from "./TeachingPlanner";
import { emptyCanvas } from "../presentation/contracts";
import { demoPlanningModel } from "./dev/demoModel";
import { TeachingStepSchema } from "./contracts";

const request = () => new TeachingPlanner({ sessionId: "transport", topic: "Equal groups" }).request(emptyCanvas());
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
it("omits server-owned prompt/schema and supports JSON-only endpoints", async () => {
  const input = request();
  const fetcher = vi.fn().mockResolvedValue(new Response('{"example":"json"}', { headers: { "Content-Type": "application/json" } }));
  expect(await createStreamingPlanningModel("/plan", fetcher)(input)).toEqual({ example: "json" });
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body).not.toHaveProperty("systemPrompt");
  expect(body).not.toHaveProperty("responseSchema");
  expect(body.context).toEqual(input.context);
});
it("rejects stale responses, abrupt EOF and explicit stream failures", async () => {
  const input = request();
  const step = TeachingStepSchema.parse(await demoPlanningModel(input));
  for (const text of [event({ version: 1, requestId: "old", type: "complete", step }), "", event({ version: 1, type: "error", error: "Stream interrupted" })]) {
    const fetcher = vi.fn().mockResolvedValue(new Response(text, { headers: { "Content-Type": "text/event-stream" } }));
    await expect(createStreamingPlanningModel("/plan", fetcher)(input)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  }
});
