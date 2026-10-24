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
  it("compiles a generated sequence against each preceding canvas and asks only at the end", async () => {
    const request = new TeachingPlanner({ sessionId: "sequence", topic: "Area" }).request(emptyCanvas());
    const candidate = { ...draft, sequence: [
      { narration: "The base is longer now.", visual: { kind: "update", changes: [{ type: "set_geometry", width: 9 }] }, interactive: false, showEquation: false },
      { narration: "Change a length to test your idea.", visual: { kind: "keep" }, interactive: true, showEquation: false },
    ] };
    const generate = vi.fn().mockResolvedValue(candidate);
    const step = await generatePlan(parseModelRequest(request), generate, new AbortController().signal);
    expect(step.beats).toHaveLength(3);
    expect(generate).toHaveBeenCalledTimes(1);
    let canvas = emptyCanvas();
    for (const [i, beat] of step.beats.entries()) {
      canvas = applyCanvasCommands(canvas, beat.cues[0].commands);
      expect(canvas.math?.visual.interactive).toBe(i === 2);
      expect(beat.narration.includes(draft.check.prompt)).toBe(i === 2);
    }
    expect(canvas.math?.visual).toMatchObject({ width: 9, height: 4 });
    candidate.sequence[0].visual = { kind: "update", changes: [{ type: "set_geometry", width: 20 }] };
    expect(() => expandCompactLesson(candidate, emptyCanvas(), "bad")).toThrow();
  });
  it("replays all moments locally, resets learner edits, and does not create extra evidence", async () => {
    const model = vi.fn(async request => generatePlan(parseModelRequest(request), async () => ({ ...draft, sequence: [
      { narration: "The base now has nine units.", visual: { kind: "update", changes: [{ type: "set_geometry", width: 9 }] }, interactive: true, showEquation: false },
    ] }), new AbortController().signal));
    const session = new TeachingSession({ sessionId: "replay", topic: "Area" }, model);
    await session.plan();
    expect(session.canInteract()).toBe(false);
    expect(session.director.getSnapshot().canvas.math?.visual).toMatchObject({ width: 6 });
    session.presentNext();
    expect(session.canInteract()).toBe(true);
    const scene = session.director.getSnapshot().canvas.math!;
    session.interactMath({ eventId: "edit", visualId: scene.visual.id, revision: scene.revision, change: { type: "set_geometry", width: 10 } });
    const previousRun = session.getSnapshot().playbackRun;
    expect(session.replay()).toBe(true);
    expect(session.getSnapshot().playbackRun).toBe(previousRun + 1);
    expect(session.director.getSnapshot().canvas.math?.visual).toMatchObject({ width: 6 });
    expect(session.canInteract()).toBe(false);
    session.presentNext();
    expect(session.director.getSnapshot().canvas.math?.visual).toMatchObject({ width: 9 });
    expect(session.planner.getSnapshot().evidence).toHaveLength(0);
    expect(model).toHaveBeenCalledTimes(1);
    session.cancel();
  });
  it("requires explanation assessment and a demonstration after a diagnosed misconception", async () => {
    const planner = new TeachingPlanner({ sessionId: "feedback", topic: "Area" });
    const initial = planner.request(emptyCanvas());
    const first = await generatePlan(parseModelRequest(initial), async () => draft, new AbortController().signal);
    planner.accept(initial.requestId, first, emptyCanvas());
    planner.presented(first.id);
    const canvas = applyCanvasCommands(emptyCanvas(), first.beats[0].cues[0].commands);
    planner.respond({ eventId: "misconception", stepId: first.id, response: { kind: "answer", text: "Area is just the width." } }, canvas);
    const request = parseModelRequest(planner.request(canvas));
    const assessment = { evidenceId: "misconception", judgement: "misconception", observation: "The learner counts only one dimension." };
    const demonstrated = { ...draft, phase: "intuition", assessment, sequence: [
      { narration: "Both rows gain squares.", visual: { kind: "update", changes: [{ type: "set_geometry", width: 8 }] }, interactive: true, showEquation: true },
    ] };
    const generate = vi.fn().mockResolvedValueOnce(draft).mockResolvedValueOnce(demonstrated);
    const result = await generatePlan(request, generate, new AbortController().signal);
    expect(result.phase).toBe("intuition");
    expect(result.beats).toHaveLength(2);
    expect(generate.mock.calls[1][0]).toContain("Assess the latest unassessed explanation");
    const repeatedDiagnosis = vi.fn().mockResolvedValueOnce({ ...draft, assessment }).mockResolvedValueOnce(demonstrated);
    expect((await generatePlan(request, repeatedDiagnosis, new AbortController().signal)).phase).toBe("intuition");
    expect(repeatedDiagnosis.mock.calls[1][0]).toContain("connected visual demonstration");
  });
  it("routes Show me directly to a demonstration without claiming an answer was correct", async () => {
    const planner = new TeachingPlanner({ sessionId: "show-me", topic: "Area" });
    const initial = planner.request(emptyCanvas());
    const first = await generatePlan(parseModelRequest(initial), async () => draft, new AbortController().signal);
    planner.accept(initial.requestId, first, emptyCanvas()); planner.presented(first.id);
    const canvas = applyCanvasCommands(emptyCanvas(), first.beats[0].cues[0].commands);
    planner.respond({ eventId: "show-me", stepId: first.id, response: { kind: "help", request: "explain" } }, canvas);
    const request = parseModelRequest(planner.request(canvas));
    const demonstration = { ...draft, phase: "intuition", sequence: [
      { narration: "The base gets longer.", visual: { kind: "update", changes: [{ type: "set_geometry", width: 8 }] }, interactive: true, showEquation: true },
    ] };
    const generate = vi.fn().mockResolvedValueOnce(draft).mockResolvedValueOnce(demonstration);
    const result = await generatePlan(request, generate, new AbortController().signal);
    expect(result.beats).toHaveLength(2);
    expect(generate.mock.calls[1][0]).toContain("explicitly asked Show me");
    expect(planner.getSnapshot().evidence.at(-1)?.outcome).toBe("not_assessed");
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
