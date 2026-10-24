import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { emptyCanvas } from "../presentation/contracts";
import { applyCanvasCommands } from "../presentation/canvasState";
import { compileMathCommand } from "../presentation/math/compact";
import { TeachingPlanner } from "../teaching/TeachingPlanner";
import { TeachingStepSchema } from "../teaching/contracts";
import { TeachingSession } from "../teaching/TeachingSession";
import { CompactLessonSchema, expandCompactLesson } from "./compactLesson";
import { generatePlan, parseModelRequest } from "./planning";

const draft = {
  phase: "diagnose", title: "Inside a rectangle", goal: "Distinguish area from lengths", approach: "introduce", reason: "Find the learner's intuition",
  narration: "These two lengths enclose a space. Try changing one of them.",
  visual: { kind: "geometry", shape: "rectangle", width: 6, height: 4 }, interactive: true, showEquation: false,
  check: { kind: "explanation", prompt: "What happens to the space when the base gets longer?", rubric: ["Explains the increase in area"] },
};
describe("compact mathematical planning", () => {
  it("uses a substantially smaller schema without any raw drawing fields", () => {
    const compact = JSON.stringify(z.toJSONSchema(CompactLessonSchema, { io: "input", reused: "ref" }));
    const previous = JSON.stringify(z.toJSONSchema(TeachingStepSchema, { io: "input", reused: "ref" }));
    expect(compact.length).toBeLessThan(previous.length * 0.5);
    expect(compact).not.toContain('"rotation"');
    expect(compact).not.toContain('"atMs"');
  });
  it("expands a compact scene and passes the existing browser planner validation", async () => {
    const planner = new TeachingPlanner({ sessionId: "compact", topic: "Why does a rectangle have area?" });
    const request = planner.request(emptyCanvas());
    const output = await generatePlan(parseModelRequest(request), vi.fn().mockResolvedValue(draft), new AbortController().signal);
    planner.accept(request.requestId, output, emptyCanvas());
    const command = output.beats[0].cues[0].commands[0];
    expect(command).toMatchObject({ type: "show_math", visual: { id: "math", kind: "geometry", width: 6, height: 4 } });
    expect(output.beats[0].narration).toContain(draft.check.prompt);
  });
  it("repairs a competing narration question before presenting the single check", async () => {
    const planner = new TeachingPlanner({ sessionId: "one-question", topic: "Rectangle area" });
    const request = parseModelRequest(planner.request(emptyCanvas()));
    const generate = vi.fn().mockResolvedValueOnce({ ...draft, narration: "What is the area?" }).mockResolvedValueOnce(draft);
    const step = await generatePlan(request, generate, new AbortController().signal);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0]).toContain("single learner question only in check.prompt");
    expect(step.beats[0].narration.match(/\?/g)).toHaveLength(1);
    expect(step.beats[0].narration.endsWith(draft.check.prompt)).toBe(true);
    expect(step.beats[0].cues[0].commands.at(-1)).toEqual({ type: "note", text: "" });
  });
  it("retains learner changes when updating an existing representation", () => {
    const options = { title: "Groups", interactive: true, showEquation: true };
    const canvas = applyCanvasCommands(emptyCanvas(), compileMathCommand({ kind: "array", rows: 4, columns: 7 }, emptyCanvas(), options));
    const updated = applyCanvasCommands(canvas, compileMathCommand({ kind: "update", changes: [{ type: "set_array", splitAt: 5 }] }, canvas, options));
    expect(updated.math?.visual).toMatchObject({ rows: 4, columns: 7, splitAt: 5, id: "math" });
    expect(() => compileMathCommand({ kind: "keep" }, emptyCanvas(), options)).toThrow();
    expect(() => compileMathCommand({ kind: "array", rows: 3, columns: 2, splitAt: 5 }, emptyCanvas(), options)).toThrow();
  });
  it("keeps interaction instant without calling the model and passes edited state to the next plan", async () => {
    const model = vi.fn(async request => expandCompactLesson(draft, request.context.canvas, request.requestId));
    // Use the same assembly step as the server for exact question wording.
    const session = new TeachingSession({ sessionId: "local", topic: "Area" }, async request => {
      const output = await model(request);
      output.beats[0].narration += " " + output.check!.prompt;
      return output;
    });
    await session.plan();
    expect(session.getSnapshot().error).toBeNull();
    session.interactMath({ eventId: "resize", visualId: "math", revision: 0, change: { type: "set_geometry", width: 9 } });
    expect(session.director.getSnapshot().canvas.math?.visual).toMatchObject({ width: 9 });
    expect(model).toHaveBeenCalledTimes(1);
    await session.respond({ kind: "answer", text: "It grows" });
    expect(model.mock.calls[1][0].context.canvas.math.visual.width).toBe(9);
  });
});
