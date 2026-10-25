import { describe, expect, it, vi } from "vitest";
import { TeachingSession } from "./TeachingSession";
import { demoPlanningModel } from "./dev/demoModel";
import { blueprintOf } from "./streaming";
import type { PlanningModel } from "./TeachingPlanner";
import { TeachingStepSchema } from "./contracts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const twoBeats: PlanningModel = async request => {
  const step = await demoPlanningModel(request);
  return { ...step, beats: [{ id: "intro", narration: "Look at the empty space.", cues: [{ id: "clear", atMs: 0, commands: [{ type: "clear", title: "Look" }] }] }, ...step.beats] };
};
const session = (model = twoBeats) => new TeachingSession({ sessionId: "voice", topic: "Equal groups" }, model, { playback: "voice" });
function finishPhrase(s: TeachingSession) {
  const token = s.getPreparedSpeech()!.token;
  expect(s.playback({ token, sequence: 0, type: "started" })).toBe(true);
  expect(s.playback({ token, sequence: 1, type: "ended" })).toBe(true);
}
describe("external speech playback", () => {
  it("prepares without drawing, waits for audible completion and gates learner answers", async () => {
    const s = session();
    expect(await s.plan()).toBe(true);
    expect(s.director.getSnapshot().status).toBe("ready");
    expect(s.getBufferedNarrations()).toHaveLength(1);
    expect(s.director.getSnapshot().canvas.title).not.toBe("Look");
    expect(s.presentNext()).toBe(false);
    const first = s.getPreparedSpeech()!;
    expect(s.playback({ token: first.token, sequence: 0, type: "ended" })).toBe(false);
    expect(await s.respond({ kind: "answer", text: "six" })).toBe(false);
    finishPhrase(s);
    expect(s.director.getSnapshot().canvas.title).toBe("Look");
    expect(s.planner.getSnapshot().status).toBe("presenting");
    finishPhrase(s);
    expect(s.getPreparedSpeech()).toBeNull();
    expect(s.planner.getSnapshot().status).toBe("awaiting_response");
    expect(s.canInteract()).toBe(true);
    expect(s.getBufferedNarrations()).toHaveLength(0);
    expect(s.playback({ token: first.token, sequence: 100, type: "ended" })).toBe(false);
  });
  it("supports pause/resume and rejects duplicate, backwards and stale playback", async () => {
    const s = session(); await s.plan();
    const speech = s.getPreparedSpeech()!, token = speech.token;
    expect(s.playback({ token, sequence: 0, type: "started" })).toBe(true);
    expect(s.playback({ token, sequence: 1, type: "progress", elapsedMs: 120 })).toBe(true);
    expect(s.playback({ token, sequence: 2, type: "progress", elapsedMs: 30 })).toBe(false);
    expect(s.playback({ token, sequence: 2, type: "paused" })).toBe(true);
    expect(s.playback({ token, sequence: 2, type: "started" })).toBe(false);
    expect(s.playback({ token, sequence: 3, type: "started" })).toBe(true);
    expect(s.replay()).toBe(true);
    expect(speech.signal.aborted).toBe(true);
    expect(s.getPreparedSpeech()!.token.runId).not.toBe(token.runId);
    expect(s.playback({ token, sequence: 4, type: "ended" })).toBe(false);
  });
  it("plays the first validated pair while the rest is still generating", async () => {
    let release!: () => void;
    const ready = deferred();
    const s = session(async (request, _signal, emit) => {
      const step = TeachingStepSchema.parse(await twoBeats(request));
      emit!({ type: "blueprint", blueprint: blueprintOf(step) });
      emit!({ type: "beat", index: 0, beat: step.beats[0] });
      ready.resolve();
      await new Promise<void>(resolve => { release = resolve; });
      emit!({ type: "beat", index: 1, beat: step.beats[1] });
      return step;
    });
    const planning = s.plan(); await ready.promise;
    expect(s.getSnapshot().busy).toBe(true);
    expect(s.getPreparedSpeech()!.beatIndex).toBe(0);
    finishPhrase(s);
    expect(s.getPreparedSpeech()).toBeNull();
    expect(s.canInteract()).toBe(false);
    release(); expect(await planning).toBe(true);
    expect(s.getPreparedSpeech()!.beatIndex).toBe(1);
    finishPhrase(s);
    expect(s.planner.getSnapshot().status).toBe("awaiting_response");
  });
  it("cancels speech and generation together and ignores later stream callbacks", async () => {
    let release!: () => void;
    const ready = deferred();
    const s = session(async (request, _signal, emit) => {
      const step = TeachingStepSchema.parse(await twoBeats(request));
      emit!({ type: "blueprint", blueprint: blueprintOf(step) });
      emit!({ type: "beat", index: 0, beat: step.beats[0] });
      ready.resolve();
      await new Promise<void>(resolve => { release = resolve; });
      emit!({ type: "beat", index: 1, beat: step.beats[1] }); return step;
    });
    const planning = s.plan(); await ready.promise;
    const speech = s.getPreparedSpeech()!;
    s.playback({ token: speech.token, sequence: 0, type: "started" });
    s.playback({ token: speech.token, sequence: 1, type: "interrupted" });
    expect(speech.signal.aborted).toBe(true);
    const canvas = structuredClone(s.director.getSnapshot().canvas);
    release(); expect(await planning).toBe(false);
    expect(s.director.getSnapshot().canvas).toEqual(canvas);
    expect(s.planner.getSnapshot().history).toHaveLength(0);
    expect(s.getPreparedSpeech()).toBeNull();
  });
  it("rejects outside scene changes and changed final narration", async () => {
    const s = session(); await s.plan();
    const speech = s.getPreparedSpeech()!;
    s.director.reset();
    expect(s.playback({ token: speech.token, sequence: 0, type: "started" })).toBe(false);
    expect(speech.signal.aborted).toBe(true);
    const changed = session(async (request, _signal, emit) => {
      const step = TeachingStepSchema.parse(await twoBeats(request));
      emit!({ type: "blueprint", blueprint: blueprintOf(step) });
      step.beats.forEach((beat, index) => emit!({ type: "beat", index, beat }));
      return { ...step, beats: [{ ...step.beats[0], narration: "Different text." }, step.beats[1]] };
    });
    expect(await changed.plan()).toBe(false);
    expect(changed.getSnapshot().error).toMatch(/already prepared/);
    expect(changed.getPreparedSpeech()).toBeNull();
  });
  it("records an interrupted final transcript as unscored context and starts a new turn", async () => {
    let latestContext = "";
    const s = session(async request => {
      latestContext = request.context.session.context.at(-1)?.text ?? "";
      return twoBeats(request);
    });
    await s.plan();
    const old = s.getPreparedSpeech()!;
    s.playback({ token: old.token, sequence: 0, type: "started" });
    expect(await s.submitTranscript("Please explain the rows again.")).toBe(true);
    expect(old.signal.aborted).toBe(true);
    expect(latestContext).toBe("Please explain the rows again.");
    expect(s.planner.getSnapshot().evidence).toHaveLength(0);
    expect(s.getPreparedSpeech()!.token.runId).not.toBe(old.token.runId);
  });
  it("reports a stall when the voice host never starts or ends a prepared phrase", async () => {
    vi.useFakeTimers();
    try {
      const s = session(); await s.plan();
      expect(s.getPreparedSpeech()).not.toBeNull();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(s.getSnapshot().error).toBeNull();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(s.getSnapshot().error).toMatch(/stalled/);
      expect(s.getPreparedSpeech()).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it("stops buffered speech and permits retry when a stream fails after the first phrase", async () => {
    let attempts = 0;
    const s = session(async (request, _signal, emit) => {
      const step = TeachingStepSchema.parse(await twoBeats(request));
      if (++attempts === 1) {
        emit!({ type: "blueprint", blueprint: blueprintOf(step) });
        emit!({ type: "beat", index: 0, beat: step.beats[0] });
        const speech = s.getPreparedSpeech()!;
        s.playback({ token: speech.token, sequence: 0, type: "started" });
        throw new Error("Connection lost.");
      }
      return step;
    });
    expect(await s.plan()).toBe(false);
    expect(s.director.getSnapshot().canvas.title).toBe("Look");
    // The phrase being spoken finishes; the failure is reported only afterwards.
    const speaking = s.getPreparedSpeech()!;
    expect(speaking.signal.aborted).toBe(false);
    expect(s.getSnapshot().error).toBeNull();
    expect(s.playback({ token: speaking.token, sequence: 1, type: "ended" })).toBe(true);
    expect(s.getSnapshot().error).toMatch(/Connection lost/);
    expect(speaking.signal.aborted).toBe(true);
    expect(s.getPreparedSpeech()).toBeNull();
    expect(s.getBufferedNarrations()).toHaveLength(0);
    expect(s.planner.getSnapshot().history).toHaveLength(0);
    expect(await s.plan()).toBe(true);
  });
});
