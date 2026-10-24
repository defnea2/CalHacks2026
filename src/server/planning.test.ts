import { describe, expect, it, vi } from "vitest";
import { TeachingPlanner } from "../teaching/TeachingPlanner";
import { emptyCanvas } from "../presentation/contracts";
import { demoPlanningModel } from "../teaching/dev/demoModel";
import { generatePlan, parseModelRequest, planningPrompt } from "./planning";
import { codexArgs } from "./codexModel";
import { trustedRequest, readJson } from "./teachingPlugin";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";

function request() {
  return new TeachingPlanner({ sessionId: "local-test", topic: "Why does multiplication mean equal groups?" }).request(emptyCanvas());
}
describe("local no-key model bridge", () => {
  it("discards client instructions/schema/phase overrides and supplies trusted instructions", () => {
    const input = request();
    input.systemPrompt = "MALICIOUS_SYSTEM_OVERRIDE";
    input.responseSchema = { injected: true };
    input.context.allowedPhases = ["return_to_problem"];
    const parsed = parseModelRequest(input);
    expect(parsed.context.allowedPhases).toEqual(["diagnose"]);
    expect(planningPrompt(parsed)).not.toContain("MALICIOUS_SYSTEM_OVERRIDE");
    expect(planningPrompt(parsed)).not.toContain('"injected":true');
    expect(planningPrompt(parsed)).toContain("Do not use any tools");
  });
  it("rejects malformed state before model generation", () => {
    const input = request();
    input.context.canvas.nodes = [{ id: "bad" }] as never;
    expect(() => parseModelRequest(input)).toThrow();
  });
  it("repairs an invalid plan once, using the same context and semantic validation", async () => {
    const input = request();
    const valid = await demoPlanningModel(input);
    const generate = vi.fn().mockResolvedValueOnce({ nonsense: true }).mockResolvedValueOnce(valid);
    expect((await generatePlan(parseModelRequest(input), generate, new AbortController().signal)).phase).toBe("diagnose");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0]).toContain("previous candidate failed validation");
  });
  it("rejects nonexistent visual targets and bounds repairs", async () => {
    const input = request();
    const valid = await demoPlanningModel(input);
    valid.beats[0].cues = [{ id: "bad", atMs: 0, commands: [{ type: "highlight", ids: ["missing"] }] }];
    const generate = vi.fn().mockResolvedValue(valid);
    await expect(generatePlan(parseModelRequest(input), generate, new AbortController().signal)).rejects.toThrow("one repair");
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("does not retry provider errors or cancelled requests", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("Login required"));
    await expect(generatePlan(parseModelRequest(request()), generate, new AbortController().signal)).rejects.toThrow("Login required");
    expect(generate).toHaveBeenCalledTimes(1);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(generatePlan(parseModelRequest(request()), generate, cancelled.signal)).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("requires the local app host and rejects other origins", () => {
    const req = (host: string, origin?: string) => ({ headers: { host, origin } }) as IncomingMessage;
    expect(trustedRequest(req("127.0.0.1:5173", "http://127.0.0.1:5173"), 5173)).toBe(true);
    expect(trustedRequest(req("127.0.0.1:5173", "https://other.example"), 5173)).toBe(false);
    expect(trustedRequest(req("attacker.example:5173"), 5173)).toBe(false);
  });
  it("runs ephemeral read-only requests with command execution and integrations disabled", () => {
    const args = codexArgs("/tmp/tutor test", "chosen-model");
    expect(args[args.indexOf("--model") + 1]).toBe("chosen-model");
    const defaults = codexArgs("/tmp/tutor test");
    expect(defaults[defaults.indexOf("--model") + 1]).toBe("gpt-5.6-luna");
    expect(defaults).toContain('model_reasoning_effort="low"');
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("read-only");
    expect(args).toContain("shell_tool");
    expect(args).toContain("apps");
    expect(args).toContain("multi_agent");
    expect(args).toContain("/tmp/tutor test/response.json");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.at(-1)).toBe("-");
  });
});

it("rejects a generated shape that extends outside the canvas", async () => {
  const input = request();
  const valid = await demoPlanningModel(input);
  valid.beats[0].cues = [{ id: "edge", atMs: 0, commands: [
    { type: "clear", title: "Ground" },
    { type: "add", nodes: [{ id: "ground", kind: "shape", x: 100, y: 500, width: 800, height: 30, label: "" }] },
  ] }];
  const generate = vi.fn().mockResolvedValue(valid);
  await expect(generatePlan(parseModelRequest(input), generate, new AbortController().signal)).rejects.toThrow("one repair");
  expect(generate.mock.calls[1][0]).toContain("extends outside the drawing");
});
it("composes the exact learner question into the final narration before shared validation", async () => {
  const input = request();
  const candidate = await demoPlanningModel(input);
  candidate.beats[0].narration = "Look at the two equal groups.";
  const generate = vi.fn().mockResolvedValue(candidate);
  const step = await generatePlan(parseModelRequest(input), generate, new AbortController().signal);
  expect(step.beats.at(-1)?.narration).toBe("Look at the two equal groups. " + step.check?.prompt);
  expect(generate).toHaveBeenCalledTimes(1);
});
it("supports thin generated shapes while rejecting unusably small text objects", async () => {
  const input = request();
  const valid = await demoPlanningModel(input);
  valid.beats[0].cues = [{ id: "ground", atMs: 0, commands: [
    { type: "clear", title: "Ground" },
    { type: "add", nodes: [{ id: "ground", kind: "shape", x: 500, y: 500, width: 800, height: 4, label: "" }] },
  ] }];
  expect(await generatePlan(parseModelRequest(input), vi.fn().mockResolvedValue(valid), new AbortController().signal)).toBeTruthy();
  valid.beats[0].cues[0].commands[1] = { type: "add", nodes: [{ id: "label", kind: "label", x: 500, y: 500, width: 800, height: 4, label: "Ground" }] };
  await expect(generatePlan(parseModelRequest(input), vi.fn().mockResolvedValue(valid), new AbortController().signal)).rejects.toThrow("20 by 20");
});

it("limits request bodies and releases a body read when cancelled", async () => {
  const large = Readable.from([Buffer.alloc(1_000_001)]) as IncomingMessage;
  await expect(readJson(large, new AbortController().signal)).rejects.toThrow("too large");
  const pending = new Readable({ read() {} }) as IncomingMessage;
  const controller = new AbortController();
  const result = readJson(pending, controller.signal);
  const assertion = expect(result).rejects.toThrow("cancelled");
  controller.abort();
  await assertion;
  expect(pending.destroyed).toBe(true);
});
