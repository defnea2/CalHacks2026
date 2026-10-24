import { describe, expect, it } from "vitest";
import { TeachingSession } from "./TeachingSession";
import { demoPlanningModel, demoTopics } from "./dev/demoModel";
import type { PlanningModel } from "./TeachingPlanner";

const session = (model: PlanningModel = demoPlanningModel, topic: typeof demoTopics[number] = demoTopics[0]) =>
  new TeachingSession({ sessionId: crypto.randomUUID(), topic: topic.label, originalQuestion: topic.homework }, model);

describe("planner and latest canvas integration", () => {
  it("adapts a wrong answer, switches representations, and reads learner changes in the next plan", async () => {
    let observed: unknown;
    const s = session(async (r) => { observed = r.context.canvas; return demoPlanningModel(r); });
    expect(await s.plan()).toBe(true);
    expect(s.director.getSnapshot().canvas.math?.visual.kind).toBe("array");
    await s.respond({ kind: "choice", optionId: "b" });
    expect(s.planner.getSnapshot().step?.phase).toBe("intuition");
    expect(s.planner.getSnapshot().evidence[0].outcome).toBe("incorrect");
    await s.respond({ kind: "help", request: "another_way" });
    const scene = s.director.getSnapshot().canvas.activity!;
    expect(scene.activity.kind).toBe("objects_groups");
    // Exercise the same public path as a learner selecting and placing an object.
    if (scene.activity.kind !== "objects_groups") throw new Error("Expected groups");
    const objectId = scene.activity.objects[0].id;
    expect(s.interactActivity({ contractVersion: "1.0.0", source: "keyboard", eventId: "select-1", sceneId: scene.sceneId, sceneRevision: scene.revision, payload: { type: "select", objectId } })).toBeTruthy();
    const selected = s.director.getSnapshot().canvas.activity!;
    expect(s.interactActivity({ contractVersion: "1.0.0", source: "keyboard", eventId: "place-1", sceneId: selected.sceneId, sceneRevision: selected.revision, payload: { type: "place", objectId, containerId: "basket-a" } })).toBeTruthy();
    const before = structuredClone(s.director.getSnapshot().canvas);
    await s.respond({ kind: "answer", text: "six" });
    expect(observed).toEqual(before);
    expect(s.planner.getSnapshot().evidence.at(-1)?.outcome).toBe("correct");
  });

  for (const topic of demoTopics) it(`completes ${topic.id} without voice`, async () => {
    const s = session(demoPlanningModel, topic);
    await s.plan();
    for (let i = 0; i < 20 && s.planner.getSnapshot().status !== "completed"; i++) {
      const check = s.planner.getSnapshot().step?.check;
      if (check?.kind === "choice") await s.respond({ kind: "choice", optionId: check.correctOptionId });
      else if (check?.kind === "number") {
        const rule = check.rule;
        if (rule.operation !== "product") throw new Error("Expected fixture product");
        await s.respond({ kind: "answer", text: String(rule.left * rule.right) });
      } else await s.plan();
      expect(s.getSnapshot().error).toBeNull();
    }
    expect(s.planner.getSnapshot().status).toBe("completed");
    expect(s.planner.recap().independentChecksPassed).toHaveLength(2);
    expect(s.planner.recap().originalQuestion).toBe(topic.homework);
  });

  it("rejects delayed results after an identical-canvas reset and can retry", async () => {
    let release!: () => void;
    let delay = true;
    const s = session(async r => {
      if (delay) await new Promise<void>(resolve => { release = resolve; });
      return demoPlanningModel(r);
    });
    const pending = s.plan();
    s.director.reset();
    release();
    expect(await pending).toBe(false);
    expect(s.planner.getSnapshot().history).toHaveLength(0);
    expect(s.getSnapshot().error).toMatch(/picture changed/);
    delay = false;
    expect(await s.plan()).toBe(true);
  });

  it("ignores cancelled results even if the provider ignores AbortSignal", async () => {
    let release!: () => void;
    let calls = 0;
    const s = session(async r => {
      if (++calls === 1) await new Promise<void>(resolve => { release = resolve; });
      return demoPlanningModel(r);
    });
    const old = s.plan();
    s.cancel();
    expect(await s.plan()).toBe(true);
    const current = s.director.getSnapshot();
    release();
    expect(await old).toBe(false);
    expect(s.director.getSnapshot()).toBe(current);
    expect(s.planner.getSnapshot().history).toHaveLength(1);
  });

  it("waits for every beat and rejects a queued beat if another renderer changed the canvas", async () => {
    const model: PlanningModel = async r => {
      const step = await demoPlanningModel(r);
      return { ...step, beats: [
        { id: "intro", narration: "First look at the groups.", cues: [{ id: "start", atMs: 0, commands: [{ type: "clear", title: "Look at groups" }] }] },
        ...step.beats,
      ] };
    };
    const s = session(model);
    await s.plan();
    expect(s.planner.getSnapshot().status).toBe("presenting");
    expect(s.canInteract()).toBe(false);
    expect(await s.respond({ kind: "choice", optionId: "a" })).toBe(false);
    expect(s.planner.getSnapshot().evidence).toHaveLength(0);
    expect(s.presentNext()).toBe(true);
    expect(s.planner.getSnapshot().status).toBe("awaiting_response");
    const second = session(model);
    await second.plan();
    second.director.reset();
    expect(second.presentNext()).toBe(false);
    expect(second.planner.getSnapshot().status).toBe("needs_plan");
    expect(second.getSnapshot().error).toMatch(/Stale teaching plan/);
  });
});
