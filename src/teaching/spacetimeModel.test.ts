// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { TeachingPlanner } from "./TeachingPlanner";
import { TeachingSession } from "./TeachingSession";
import { TeachingStepSchema, type TeachingStep } from "./contracts";
import { emptyCanvas } from "../presentation/contracts";
import { demoPlanningModel, demoTopics } from "./dev/demoModel";
import type { PlanningProgress } from "./streaming";
import {
  beatRowToVisual, contiguousBeats, createFeedPlanningModel, stepMeta, triggerFor,
  type BeatRowLike, type LessonFeed, type LessonFeedSnapshot, type LessonStateLike,
} from "./spacetimeModel";

const SID = 7n;
class FakeFeed implements LessonFeed {
  snap: { beats: BeatRowLike[]; tutorTurns: LessonFeedSnapshot["tutorTurns"][number][]; lessonState: LessonStateLike | undefined; session: NonNullable<LessonFeedSnapshot["session"]> } = {
    beats: [], tutorTurns: [], lessonState: undefined,
    session: { id: SID, turnCount: 0, currentUtteranceId: 0n, turnState: "listening", active: true },
  };
  calls: string[] = [];
  private listeners = new Set<() => void>();
  snapshot = () => this.snap;
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  emit() { this.listeners.forEach(l => l()); }
  submitTextTurn = vi.fn(async (text: string, intent: string) => { this.calls.push(`text:${text}|${intent}`); this.snap.session.turnCount++; });
  submitInteraction = vi.fn(async (kind: string, _payload: string) => { this.calls.push(`interaction:${kind}`); });
  startConversation = vi.fn(async () => { this.calls.push("start"); });
  interrupt = vi.fn(async () => { this.calls.push("interrupt"); });
  beat(utteranceId: bigint, idx: number, step: TeachingStep) {
    const { narration, ...visual } = step.beats[idx]!;
    this.snap.beats.push({ id: BigInt(this.snap.beats.length + 1), sessionId: SID, utteranceId, idx, visual: JSON.stringify(visual), narration, sentenceIdx: idx, canvasVersion: idx + 1 });
    this.emit();
  }
  lesson(step: TeachingStep) {
    const { beats: _b, ...meta } = step;
    this.snap.lessonState = { sessionId: SID, stage: step.phase, awaitingResponse: false, checkPrompt: step.check?.prompt ?? "", evidence: "[]", notes: JSON.stringify({ step: meta }) };
  }
  done(utteranceId: bigint, interrupted = false) {
    this.snap.tutorTurns.push({ sessionId: SID, role: "tutor", utteranceId, interrupted });
    this.emit();
  }
}

const config = { sessionId: "stdb", topic: demoTopics[0].label, originalQuestion: demoTopics[0].homework };
const flush = () => new Promise(r => setTimeout(r, 0));
/** The offline demo lesson with two extra opening moments (so ordering is observable). */
async function demoStep(): Promise<TeachingStep> {
  const step = TeachingStepSchema.parse(await demoPlanningModel(new TeachingPlanner(config).request(emptyCanvas())));
  const intro = (id: string, text: string) => ({ id, narration: text, cues: [{ id: `${id}-c`, atMs: 0, commands: [{ type: "note" as const, text }] }] });
  return TeachingStepSchema.parse({ ...step, beats: [intro("intro-a", "Let us look."), intro("intro-b", "Here is a picture."), ...step.beats] });
}

describe("createFeedPlanningModel", () => {
  it("starts the conversation, then feeds blueprint and beats in idx order and resolves on the tutor turn", async () => {
    const feed = new FakeFeed();
    const step = await demoStep();
    expect(step.beats.length).toBeGreaterThan(1);
    const events: PlanningProgress[] = [];
    const result = createFeedPlanningModel(feed)(new TeachingPlanner(config).request(emptyCanvas()), undefined, e => events.push(e));
    await flush();
    expect(feed.calls).toEqual(["start"]);
    feed.lesson(step);
    // Rows arrive out of order: idx 1 waits for idx 0.
    feed.beat(5n, 1, step);
    expect(events).toEqual([]);
    feed.beat(5n, 0, step);
    for (let i = 2; i < step.beats.length; i++) feed.beat(5n, i, step);
    expect(events.map(e => e.type === "beat" ? `beat${e.index}` : e.type)).toEqual(["blueprint", ...step.beats.map((_, i) => `beat${i}`)]);
    feed.done(5n);
    const out = TeachingStepSchema.parse(await result);
    expect(out.beats.map(b => b.narration)).toEqual(step.beats.map(b => b.narration));
    expect(out.check).toEqual(step.check);
  });

  it("drives the team's TeachingSession unchanged (planner accepts the streamed step)", async () => {
    const feed = new FakeFeed();
    const step = await demoStep();
    const session = new TeachingSession(config, createFeedPlanningModel(feed));
    const planned = session.plan();
    await flush();
    feed.lesson(step);
    step.beats.forEach((_, i) => feed.beat(3n, i, step));
    feed.done(3n);
    expect(await planned).toBe(true);
    expect(session.getSnapshot().error).toBeNull();
    expect(session.planner.getSnapshot().step?.beats).toHaveLength(step.beats.length);
    expect(session.skipToEnd()).toBe(true);
    expect(session.director.getSnapshot().canvas.math).not.toBeNull();
    expect(session.planner.getSnapshot().status).toBe("awaiting_response");
  });

  it("ignores utterances that existed before the request", async () => {
    const feed = new FakeFeed();
    const step = await demoStep();
    feed.lesson(step);
    step.beats.forEach((_, i) => feed.beat(2n, i, step));
    feed.done(2n);
    const events: PlanningProgress[] = [];
    const result = createFeedPlanningModel(feed)(new TeachingPlanner(config).request(emptyCanvas()), undefined, e => events.push(e));
    await flush();
    expect(events).toEqual([]);
    step.beats.forEach((_, i) => feed.beat(9n, i, step));
    feed.done(9n);
    await expect(result).resolves.toBeTruthy();
    expect(events.filter(e => e.type === "beat")).toHaveLength(step.beats.length);
  });

  it("abort calls interrupt and rejects", async () => {
    const feed = new FakeFeed();
    const step = await demoStep();
    const controller = new AbortController();
    const result = createFeedPlanningModel(feed)(new TeachingPlanner(config).request(emptyCanvas()), controller.signal);
    await flush();
    feed.beat(4n, 0, step);
    controller.abort(new Error("stop"));
    await expect(result).rejects.toThrow("stop");
    expect(feed.interrupt).toHaveBeenCalledOnce();
    // later rows are ignored after abort
    feed.done(4n);
  });

  it("rejects a reply without a picture, a module error and malformed visuals", async () => {
    const step = await demoStep();
    const req = () => new TeachingPlanner(config).request(emptyCanvas());
    let feed = new FakeFeed();
    let result = createFeedPlanningModel(feed)(req());
    await flush();
    feed.done(6n, true);
    await expect(result).rejects.toThrow(/interrupted/);

    feed = new FakeFeed();
    result = createFeedPlanningModel(feed)(req());
    await flush();
    feed.snap.lessonState = { sessionId: SID, stage: "", awaitingResponse: false, checkPrompt: "", evidence: "[]", notes: JSON.stringify({ error: "Visual rejected twice" }) };
    feed.beat(6n, 0, step); feed.snap.beats = []; feed.done(6n);
    await expect(result).rejects.toThrow("Visual rejected twice");

    feed = new FakeFeed();
    result = createFeedPlanningModel(feed)(req());
    await flush();
    feed.snap.beats.push({ id: 1n, sessionId: SID, utteranceId: 6n, idx: 0, visual: "{oops", narration: "x", sentenceIdx: 0, canvasVersion: 1 });
    feed.emit();
    await expect(result).rejects.toThrow();
  });

  it("times out when no beat arrives", async () => {
    vi.useFakeTimers();
    try {
      const feed = new FakeFeed();
      const result = createFeedPlanningModel(feed, { firstBeatTimeoutMs: 1000 })(new TeachingPlanner(config).request(emptyCanvas()));
      const check = expect(result).rejects.toThrow(/did not answer/);
      await vi.advanceTimersByTimeAsync(1001);
      await check;
    } finally { vi.useRealTimers(); }
  });

  it("propagates a failing trigger reducer", async () => {
    const feed = new FakeFeed();
    feed.startConversation.mockRejectedValueOnce(new Error("session has ended"));
    await expect(createFeedPlanningModel(feed)(new TeachingPlanner(config).request(emptyCanvas()))).rejects.toThrow("session has ended");
  });
});

describe("triggerFor", () => {
  it("maps learner responses to turns with intents, once each", async () => {
    const planner = new TeachingPlanner(config);
    const step = await demoStep();
    planner.accept(planner.request(emptyCanvas()).requestId, step, emptyCanvas());
    planner.presented(step.id);
    const sent = new Set<string>();
    const kind = step.check!.kind;
    const response = kind === "choice" ? { kind: "choice" as const, optionId: step.check!.kind === "choice" ? step.check!.options[0]!.id : "" } : { kind: "answer" as const, text: "56" };
    planner.respond({ eventId: "e1", stepId: step.id, response }, emptyCanvas());
    const first = triggerFor(planner.request(emptyCanvas()), sent);
    expect(first.trigger.kind).toBe("text");
    expect(first.key).toBe("e1");
    sent.add(first.key);
    // the same evidence again (a retry) is a plain continue, not a duplicate answer
    expect(triggerFor(planner.request(emptyCanvas()), sent).trigger).toEqual({ kind: "text", text: "", intent: "continue" });
  });

  it("maps help requests to lesson intents", async () => {
    const step = await demoStep();
    for (const [request, intent] of [["simpler", "smaller_step"], ["another_way", "another_way"], ["explain", "demonstrate"]] as const) {
      const planner = new TeachingPlanner(config);
      planner.accept(planner.request(emptyCanvas()).requestId, step, emptyCanvas());
      planner.respond({ eventId: `h-${request}`, stepId: step.id, response: { kind: "help", request } }, emptyCanvas());
      expect(triggerFor(planner.request(emptyCanvas()), new Set()).trigger).toEqual({ kind: "text", text: "", intent });
    }
  });
});

describe("row mapping", () => {
  it("accepts command arrays and {commands} as one cue, and orders contiguous rows", () => {
    const cmd = { type: "note", text: "Hi" };
    const row = (idx: number, visual: unknown): BeatRowLike => ({ id: BigInt(idx), sessionId: SID, utteranceId: 1n, idx, visual: JSON.stringify(visual), narration: "Look.", sentenceIdx: idx, canvasVersion: 0 });
    expect(beatRowToVisual(row(0, [cmd])).cues[0]!.commands).toHaveLength(1);
    expect(beatRowToVisual(row(0, { commands: [cmd] })).cues).toHaveLength(1);
    expect(contiguousBeats([row(2, [cmd]), row(0, [cmd])], 1n).map(r => r.idx)).toEqual([0]);
  });

  it("derives a schema-valid step when lesson_state has no step notes", () => {
    const meta = stepMeta({ sessionId: SID, stage: "solo", awaitingResponse: true, checkPrompt: "What is 3 × 4?", evidence: "[]", notes: "" }, 1n, "Now you. What is 3 × 4?");
    expect(meta.check?.prompt).toBe("What is 3 × 4?");
    expect(meta.phase).toBe("solo");
    const unspoken = stepMeta({ sessionId: SID, stage: "solo", awaitingResponse: true, checkPrompt: "What is 3 × 4?", evidence: "[]", notes: "" }, 1n, "Look.");
    expect(unspoken.check).toBeNull();
    expect(unspoken.phase).toBe("intuition");
  });
});
