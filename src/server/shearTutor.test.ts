// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createShearTutor } from "./shearTutor";

const request = { version: 1, requestId: "r1", revision: 5, turn: "reveal", learnerText: null, history: [],
  lesson: { prediction: "bigger", base: 6, height: 4, shear: 3, largestShear: 5, adjustments: 4, proofsWatched: 1, attempts: 1 } };
const answer = { reply: "Bigger is a natural guess.", followUp: "Why did it stay the same?", understanding: "not_yet" };
const provider = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("slant tutor", () => {
  it("sends the learner's actual prediction and computed facts with structured output", async () => {
    const fetcher = vi.fn().mockResolvedValue(provider({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }] }));
    const result = await createShearTutor({ apiKey: "server-secret", fetcher })(request, new AbortController().signal);
    expect(result).toEqual({ requestId: "r1", revision: 5, ...answer });
    const payload = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(payload.output_config.format.type).toBe("json_schema");
    const data = JSON.parse(payload.messages[0].content.split("\n").slice(1).join("\n"));
    expect(data.facts).toMatchObject({ base: 6, height: 4, area: 24, shear: 3 });
    expect(data.learnerActions).toMatchObject({ prediction: "bigger", largestShear: 5 });
  });

  it("rejects malformed state before calling the provider", async () => {
    const fetcher = vi.fn();
    await expect(createShearTutor({ apiKey: "k", fetcher })({ ...request, lesson: { ...request.lesson, base: -1 } }, new AbortController().signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports provider failures without leaking details and refuses truncated replies", async () => {
    const tutor = (r: Response) => createShearTutor({ apiKey: "k", fetcher: vi.fn().mockResolvedValue(r) })(request, new AbortController().signal);
    await expect(tutor(provider({ error: "secret detail" }, 401))).rejects.toThrow("Anthropic authentication failed");
    await expect(tutor(provider({ stop_reason: "max_tokens", content: [{ type: "text", text: "{" }] }))).rejects.toThrow("did not finish");
  });
});
