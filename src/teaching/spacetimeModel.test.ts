// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { TeachingPlanner } from "./TeachingPlanner";
import { TeachingSession } from "./TeachingSession";
import { TeachingStepSchema, type TeachingStep } from "./contracts";
import { emptyCanvas } from "../presentation/contracts";
import { demoPlanningModel, demoTopics } from "./dev/demoModel";
import type { PlanningProgress } from "./streaming";
import {
  beatRowToVisual, checkFromPublic, contiguousBeats, createFeedPlanningModel, stepFromRows, triggerFor,
  type BeatRowLike, type LessonFeed, type LessonFeedSnapshot, type LessonStateLike,
} from "./spacetimeModel";

const SID = 7n;
/** The module's public check view (spacetimedb/src/pipeline.ts publicCheck): no answer key. */
const publicCheck = (check: TeachingStep["check"]) => {
  if (!check) return null;
  if (check.kind === "choice") return { kind: check.kind, prompt: check.prompt, options: check.options };
  return { kind: check.kind, prompt: check.prompt };
};

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
  submitInteraction = vi.fn(async (kind: string, payload: string) => { this.calls.push(`interaction:${kind}:${payload}`); });
  startConversation = vi.fn(async () => { this.calls.push("start"); });
  interrupt = vi.fn(async () => { this.calls.push("interrupt"); });
  beat(utteranceId: bigint, idx: number, step: TeachingStep, emit = true) {
    const { narration, ...visual } = step.beats[idx]!;
    this.snap.beats.push({ id: BigInt(this.snap.beats.length + 1), sessionId: SID, utteranceId, idx, visual: JSON.stringify(visual), narration, sentenceIdx: idx, canvasVersion: idx + 1 });
    if (emit) this.emit();
  }
  /** The module accepts the step at its final beat and publishes it (same transaction). */
  accept(step: TeachingStep) {
    this.snap.lessonState = {
      sessionId: SID, stage: "presenting", awaitingResponse: false, checkPrompt: step.check?.prompt ?? "", evidence: "[]",
      notes: JSON.stringify({ stepId: step.id, phase: step.phase, learningGoal: step.learningGoal, approach: step.approach, beatCount: step.beats.length, check: publicCheck(step.check), steps: [] }),
    };
  }
  finalBeat(utteranceId: bigint, step: TeachingStep) {
    this.beat(utteranceId, step.beats.length - 1, step, false);
    this.accept(step);
    this.emit();
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
const request = () => new TeachingPlanner(config).request(emptyCanvas());

describe("createFeedPlanningModel", () => {
  it("starts the conversation, waits for the accepted step, then reports blueprint and beats in idx order", async () => {
    const feed = new FakeFeed();
    const step = await demoStep();
    const n = step.beats.length;
    expect(n).toBeGreaterThan(2);
    const events: PlanningProgress[] = [];
    const result = createFeedPlanningModel(feed)(request(), undefined, e => events.push(e));
    await flush();
    expect(feed.calls).toEqual(["start"]);
    // Rows arrive out of order; nothing is reported before the module accepted the step.
    feed.beat(5n, 1, step);
    feed.beat(5n, 0, step);
    for (let i = 2; i < n - 1; i++) feed.beat(5n, i, step);
    expect(events).toEqual([]);
    feed.finalBeat(5n, step);
    expect(events.map(e => e.type === "beat" ? `beat${e.index}` : e.type)).toEqual(["blueprint", ...step.beats.map((_, i) => `beat${i}`)]);
    const out = TeachingStepSchema.parse(await result);
    expect(out.id).toBe(step.id);
    expect(out.beats.map(b => b.narration)).toEqual(step.beats.map(b => b.narration));
    expect(out.check?.prompt).toBe(step.check?.prompt);
  });

  it("drives the team's TeachingSession unchanged (planner accepts the step)", async () => {
    const feed = new FakeFeed();
    const step = await demoStep();
    const session = new TeachingSession(config, createFeedPlanningModel(feed));
    const planned = session.plan();
    await flush();
    for (let i = 0; i < step.beats.length - 1; i++) feed.beat(3n, i, step);
    feed.finalBeat(3n, step);
    expect(await planned).toBe(true);
    expect(session.getSnapshot().error).toBeNull();
    expect(session.planner.getSnapshot().step?.beats).toHaveLength(step.beats.length);
    expect(session.skipToEnd()).toBe(true);
    expect(session.director.getSnapshot().canvas.math).not.toBeNull();
    expect(session.planner.getSnapshot().status).toBe("awaiting_response");
  });

  it("ignores utterances and steps that existed before the request", async () => {
    const feed = new FakeFeed();
    const old = await demoStep();
    old.beats.forEach((_, i) => feed.beat(2n, i, old));
    feed.accept(old);
    feed.done(2n);
    const events: PlanningProgress[] = [];
    const result = createFeedPlanningModel(feed)(request(), undefined, e => events.push(e));
    await flush();
    expect(events).toEqual([]);
    const next = { ...old, id: "next-step" };
    for (let i = 0; i < next.beats.length - 1; i++) feed.beat(9n, i, next);
    expect(events).toEqual([]); // notes still describe the old step
    feed.finalBeat(9n, next);
    await expect(result).resolves.toMatchObject({ id: "next-step" });
    expect(events.filter(e => e.type === "beat")).toHaveLength(next.beats.length);
  });

  it("abort calls interrupt and rejects", async () => {
    const feed = new FakeFeed();
    const step = await demoStep();
    const controller = new AbortController();
    const result = createFeedPlanningModel(feed)(request(), controller.signal);
    await flush();
    feed.beat(4n, 0, step);
    controller.abort(new Error("stop"));
    await expect(result).rejects.toThrow("stop");
    expect(feed.interrupt).toHaveBeenCalledOnce();
    feed.done(4n); // later rows are ignored
  });

  it("rejects a reply without a picture, an unfinished lesson and malformed visuals", async () => {
    const step = await demoStep();
    let feed = new FakeFeed();
    let result = createFeedPlanningModel(feed)(request());
    await flush();
    feed.done(6n, true);
    await expect(result).rejects.toThrow(/interrupted before its picture/);

    feed = new FakeFeed();
    result = createFeedPlanningModel(feed)(request());
    await flush();
    feed.beat(6n, 0, step);
    feed.done(6n);
    await expect(result).rejects.toThrow(/could not finish/);

    feed = new FakeFeed();
    result = createFeedPlanningModel(feed)(request());
    await flush();
    feed.snap.beats.push({ id: 1n, sessionId: SID, utteranceId: 6n, idx: 0, visual: "{oops", narration: "x", sentenceIdx: 0, canvasVersion: 1 });
    feed.accept({ ...step, beats: step.beats.slice(0, 1) } as TeachingStep);
    feed.emit();
    await expect(result).rejects.toThrow();
  });

  it("times out when no beat arrives", async () => {
    vi.useFakeTimers();
    try {
      const feed = new FakeFeed();
      const result = createFeedPlanningModel(feed, { firstBeatTimeoutMs: 1000 })(request());
      const check = expect(result).rejects.toThrow(/did not answer/);
      await vi.advanceTimersByTimeAsync(1001);
      await check;
    } finally { vi.useRealTimers(); }
  });

  it("propagates a failing trigger reducer", async () => {
    const feed = new FakeFeed();
    feed.startConversation.mockRejectedValueOnce(new Error("session has ended"));
    await expect(createFeedPlanningModel(feed)(request())).rejects.toThrow("session has ended");
  });
});

describe("triggerFor", () => {
  it("maps answers to text turns and choices/pictures to module interactions, once each", async () => {
    const step = await demoStep();
    const sent = new Set<string>();
    const planner = new TeachingPlanner(config);
    planner.accept(planner.request(emptyCanvas()).requestId, step, emptyCanvas());
    planner.presented(step.id);
    const check = step.check!;
    const response = check.kind === "choice" ? { kind: "choice" as const, optionId: check.options[0]!.id } : { kind: "answer" as const, text: "56" };
    planner.respond({ eventId: "e1", stepId: step.id, response }, emptyCanvas());
    const first = triggerFor(planner.request(emptyCanvas()), sent);
    expect(first.key).toBe("e1");
    expect(first.trigger).toEqual(check.kind === "choice"
      ? { kind: "interaction", interaction: "choice", payload: JSON.stringify({ optionId: check.options[0]!.id }) }
      : { kind: "text", text: "56", intent: "" });
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

  it("rebuilds schema-valid team checks from the public view (answer key stays in the module)", () => {
    expect(checkFromPublic({ kind: "choice", prompt: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] })).toMatchObject({ kind: "choice", correctOptionId: "a" });
    expect(checkFromPublic({ kind: "number", prompt: "How many?" })).toMatchObject({ kind: "number" });
    expect(checkFromPublic({ kind: "explanation", prompt: "Why?" })).toMatchObject({ kind: "explanation" });
    expect(checkFromPublic(null)).toBeNull();
    const narration = "Now you. What is 3 × 4?";
    const step = stepFromRows({ sessionId: SID, stage: "awaiting_response", awaitingResponse: true, checkPrompt: "What is 3 × 4?", evidence: "[]",
      notes: JSON.stringify({ stepId: "s1", phase: "solo", learningGoal: "Multiply.", approach: "challenge", beatCount: 1, check: { kind: "number", prompt: "What is 3 × 4?" } }) },
      [{ id: "b", narration, cues: [] }]);
    expect(step).toMatchObject({ id: "s1", phase: "solo", approach: "challenge", check: { kind: "number" } });
  });
});
