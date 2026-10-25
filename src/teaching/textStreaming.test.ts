import { describe, expect, it, vi } from "vitest";
import { TeachingSession } from "./TeachingSession";
import { demoPlanningModel } from "./dev/demoModel";
import { TeachingStepSchema } from "./contracts";
import { blueprintOf } from "./streaming";
import type { PlanningModel } from "./TeachingPlanner";

const twoBeats: PlanningModel = async request => {
  const step = await demoPlanningModel(request);
  return { ...step, beats: [{ id: "intro", narration: "Watch the groups grow.", cues: [{ id: "first", atMs: 0, commands: [{ type: "clear", title: "A picture right away" }] }] }, ...step.beats] };
};

describe("streamed visual lessons without a voice transport", () => {
  it("shows validated opening before generation finishes and gates the check until completion", async () => {
    let release!: () => void;
    let ready!: () => void;
    const first = new Promise<void>(resolve => { ready = resolve; });
    const s = new TeachingSession({ sessionId: "stream-text", topic: "Equal groups" }, async (request, _signal, emit) => {
      const step = TeachingStepSchema.parse(await twoBeats(request));
      emit!({ type: "blueprint", blueprint: blueprintOf(step) });
      emit!({ type: "beat", index: 0, beat: step.beats[0] });
      ready();
      await new Promise<void>(resolve => { release = resolve; });
      emit!({ type: "beat", index: 1, beat: step.beats[1] });
      return step;
    });
    const planning = s.plan();
    await first;
    expect(s.getSnapshot().busy).toBe(true);
    expect(s.getSnapshot().beatIndex).toBe(0);
    expect(s.getLessonOutline()?.beatCount).toBe(2);
    expect(s.director.getSnapshot().canvas.title).toBe("A picture right away");
    expect(s.canInteract()).toBe(false);
    expect(s.presentNext()).toBe(false);
    const run = s.getSnapshot().playbackRun;
    release();
    expect(await planning).toBe(true);
    expect(s.getSnapshot().beatIndex).toBe(0);
    expect(s.getSnapshot().playbackRun).toBe(run);
    expect(s.planner.getSnapshot().status).toBe("presenting");
    expect(s.presentNext()).toBe(true);
    expect(s.planner.getSnapshot().status).toBe("awaiting_response");
    expect(s.canInteract()).toBe(true);
  });

  it("plays an open blueprint beat by beat, waits for later beats, and finalizes on complete", async () => {
    const gates: Array<() => void> = [];
    const gate = () => new Promise<void>(resolve => gates.push(resolve));
    const s = new TeachingSession({ sessionId: "open-text", topic: "Equal groups" }, async (request, _signal, emit) => {
      const base = TeachingStepSchema.parse(await demoPlanningModel(request));
      const mk = (i: number) => ({ id: `o${i}`, narration: `Part ${i} of the idea.`, cues: [{ id: `c${i}`, atMs: 0, commands: [{ type: "clear" as const, title: `Picture ${i}` }] }] });
      const beats = [0, 1, 2, 3].map(mk);
      const step = TeachingStepSchema.parse({ ...base, beats: beats.map((b, i) => i === 3 ? { ...b, narration: b.narration + " " + base.check!.prompt } : b) });
      const bp = blueprintOf(step);
      emit!({ type: "blueprint", blueprint: { ...bp, beats: bp.beats.slice(0, 1), open: true } });
      emit!({ type: "beat", index: 0, beat: step.beats[0] });
      for (let i = 1; i < 4; i++) { await gate(); emit!({ type: "beat", index: i, beat: step.beats[i] }); }
      await gate();
      return step;
    });
    const planning = s.plan();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(s.getSnapshot().beatIndex).toBe(0);
    expect(s.hasNextBeat()).toBe(false);
    expect(s.presentNext()).toBe(false);
    expect(s.getSnapshot().error).toBeNull();
    for (let i = 1; i < 4; i++) {
      gates[i - 1]();
      await vi.waitFor(() => expect(s.hasNextBeat()).toBe(true));
      expect(s.getLessonOutline()?.beatCount).toBe(i + 1);
      expect(s.presentNext()).toBe(true);
      await vi.waitFor(() => expect(gates).toHaveLength(i + 1));
    }
    expect(s.planner.getSnapshot().status).not.toBe("awaiting_response");
    gates[3]();
    expect(await planning).toBe(true);
    expect(s.getSnapshot().error).toBeNull();
    expect(s.planner.getSnapshot().status).toBe("awaiting_response");
    expect(s.director.getSnapshot().canvas.title).toBe("Picture 3");
  });

  it("retains the visible partial lesson on a failed stream and retries from the current picture", async () => {
    let calls = 0;
    const s = new TeachingSession({ sessionId: "retry-text", topic: "Equal groups" }, async (request, _signal, emit) => {
      const step = TeachingStepSchema.parse(await twoBeats(request));
      if (++calls === 1) {
        emit!({ type: "blueprint", blueprint: blueprintOf(step) });
        emit!({ type: "beat", index: 0, beat: step.beats[0] });
        throw new Error("Connection lost");
      }
      expect(request.context.canvas.title).toBe("A picture right away");
      return step;
    });
    expect(await s.plan()).toBe(false);
    expect(s.planner.getSnapshot().history).toHaveLength(0);
    expect(s.canInteract()).toBe(false);
    expect(s.presentNext()).toBe(false);
    expect(await s.plan()).toBe(true);
  });

  it("repeats accepted lessons locally without a model round trip or new evidence", async () => {
    const model = vi.fn(twoBeats);
    const s = new TeachingSession({ sessionId: "repeat-text", topic: "Equal groups" }, model);
    await s.plan(); s.presentNext();
    expect(await s.respond({ kind: "help", request: "repeat" })).toBe(true);
    expect(model).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot().beatIndex).toBe(0);
    expect(s.planner.getSnapshot().evidence).toHaveLength(0);
  });
});
