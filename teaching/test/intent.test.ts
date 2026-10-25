// Push back, then let the learner decide (teaching/intent.ts): keyword intents, the pending
// confirmation, and the arc phases a confirmed decision allows.
import { describe, expect, it } from "vitest";
import { arcs } from "../../shared/src/lesson/pack/arcs";
import { arcPhases, LessonArcSchema, type LessonArc } from "../src/teaching/arc";
import { classifyIntent, decideTurn, flowSensitive, PUSHBACK } from "../src/teaching/intent";
import { acceptStep, newLessonRecord, type LessonRecord } from "../src/teaching/lessonFlow";
import type { TeachingStep } from "../src/teaching/contracts";

const arc: LessonArc = LessonArcSchema.parse(arcs.demo2min);
const step = (phase: TeachingStep["phase"], prompt = "What is 1/2 in quarters?") =>
  ({ id: `s-${phase}`, phase, check: { kind: "number", prompt, rule: { operation: "value", value: 2 } }, beats: [] }) as unknown as TeachingStep;
const fresh = (): LessonRecord => newLessonRecord({ sessionId: "s1", topic: "Expand 2/3", originalQuestion: "Expand 2/3 to twelfths", lessonStyle: "mini_lesson", arc });
const awaiting = (phase: TeachingStep["phase"] = "intuition"): LessonRecord => ({ ...fresh(), step: step(phase), status: "awaiting_response" });

describe("classifyIntent", () => {
  it.each([
    ["Just tell me the answer.", "ask_answer"],
    ["what's the answer", "ask_answer"],
    ["Can you do my homework for me", "ask_answer"],
    ["Can I just do a task?", "skip"],
    ["just give me a task", "skip"],
    ["I want to stop", "end"],
    ["can we do a different topic", "switch_topic"],
    ["say it again slower", "repeat"],
    ["another picture please", "another_picture"],
    ["this is too hard", "simpler"],
    ["what's your favourite game?", "off_topic"],
    ["what's your address", "private"],
    ["I'm sad", "feelings"],
    ["I don't know", "answer"],
    ["8/12", "answer"],
    ["two quarters", "answer"],
    ["I do not get it.", "answer"],
    ["yes", "answer"], // no confirmation pending: an ordinary answer
  ])("%s -> %s", (text, intent) => expect(classifyIntent(text)).toBe(intent));

  it("yes / no only mean confirm / decline while a confirmation is pending", () => {
    expect(classifyIntent("yes, please tell me", true)).toBe("confirm");
    expect(classifyIntent("Yeah", true)).toBe("confirm");
    expect(classifyIntent("ok, let's figure it out", true)).toBe("decline");
    expect(classifyIntent("no", true)).toBe("decline");
    expect(classifyIntent("no thanks", false)).toBe("answer");
    expect(flowSensitive("yes")).toBe(true);
    expect(flowSensitive("eight twelfths")).toBe(false);
  });
});

describe("decideTurn", () => {
  it("ask for the answer -> push back; yes -> give_answer (hand back with the answer)", () => {
    const a = decideTurn(awaiting(), "Just tell me the answer.", "t1");
    expect(a.handled).toBe(true);
    expect(a.record.pending).toMatchObject({ kind: "ask_answer", turnId: "t1" });
    expect(a.record.reply).toEqual({ turnId: "t1", lines: [PUSHBACK.ask_answer], sayOnly: true });
    expect(a.record.status).toBe("awaiting_response"); // nothing changed yet
    const b = decideTurn(a.record, "yes, please tell me", "t2");
    expect(b.record.pending).toBeUndefined();
    expect(b.record.config.decision).toBe("give_answer");
    expect(b.record.status).toBe("needs_plan");
    expect(b.record.reply).toMatchObject({ turnId: "t2", sayOnly: false });
    expect(arcPhases(arc, b.record.step, undefined, b.record.config.decision)).toEqual(["return_to_problem"]);
    // The decision shapes exactly one step.
    expect(acceptStep(b.record, step("return_to_problem"), []).config.decision).toBeUndefined();
  });

  it("insisting (same request again) counts as yes", () => {
    const a = decideTurn(awaiting(), "Just tell me the answer.", "t1");
    expect(decideTurn(a.record, "just tell me the answer!", "t2").record.config.decision).toBe("give_answer");
  });

  it("no -> the open task is asked again, the lesson stays where it was", () => {
    const a = decideTurn(awaiting(), "Just tell me the answer.", "t1");
    const b = decideTurn(a.record, "ok, let's figure it out", "t2");
    expect(b.record.status).toBe("awaiting_response");
    expect(b.record.config.decision).toBeUndefined();
    expect(b.record.reply).toEqual({ turnId: "t2", lines: ["Great, let's figure it out together.", "What is 1/2 in quarters?"], sayOnly: true });
  });

  it("task during the explanation -> confirm; yes -> task stage; no -> the explanation resumes", () => {
    const r: LessonRecord = { ...fresh(), status: "needs_plan" }; // explanation cut short
    const a = decideTurn(r, "Can I just do a task?", "t1");
    expect(a.record.pending?.kind).toBe("skip_to_task");
    const yes = decideTurn(a.record, "yes", "t2");
    expect(yes.record.config.decision).toBe("task_now");
    expect(arcPhases(arc, null, undefined, "task_now")).toEqual(["solo"]);
    const no = decideTurn(a.record, "no", "t2");
    expect(no.record.config.decision).toBe("resume");
    expect(no.record.reply).toMatchObject({ lines: ["Okay, let's look at the idea first."], sayOnly: false });
    expect(arcPhases(arc, null, undefined, "resume")).toEqual(["intuition"]);
    expect(arcPhases(arc, step("intuition"), undefined, "resume")).toEqual(["intuition"]);
  });

  it("skip during the repair -> confirm; yes -> hand back", () => {
    const a = decideTurn(awaiting("repair"), "can we skip this", "t1");
    expect(a.record.pending?.kind).toBe("skip_repair");
    const b = decideTurn(a.record, "yes", "t2");
    expect(b.record.config.decision).toBe("hand_back");
    expect(arcPhases(arc, step("repair"), undefined, "hand_back")).toEqual(["return_to_problem"]);
  });

  it("end -> confirm; yes -> authored goodbye, lesson completed", () => {
    const a = decideTurn(awaiting(), "I want to stop", "t1");
    const b = decideTurn(a.record, "yes", "t2");
    expect(b.record.status).toBe("completed");
    expect(b.record.reply?.sayOnly).toBe(true);
  });

  it("small requests are done without a confirmation", () => {
    expect(decideTurn(awaiting(), "say it again slower", "t1")).toMatchObject({ handled: false, help: "repeat" });
    expect(decideTurn(awaiting(), "another picture", "t1")).toMatchObject({ handled: false, help: "another_way" });
    expect(decideTurn(awaiting(), "Give me a task", "t1").record.reply?.lines).toEqual(["Here is your task.", "What is 1/2 in quarters?"]);
  });

  it("off-topic / personal: one steering line, no confirmation loop, task kept", () => {
    const o = decideTurn(awaiting(), "what's your favourite game?", "t1");
    expect(o.record.pending).toBeUndefined();
    expect(o.record.reply?.lines).toHaveLength(2);
    expect(o.record.reply?.lines[1]).toBe("What is 1/2 in quarters?");
    expect(o.record.status).toBe("awaiting_response");
    const sad = decideTurn(awaiting(), "I'm sad", "t1");
    expect(sad.record.reply?.lines[0]).toMatch(/grown-up you trust/);
    expect(decideTurn(awaiting(), "what's your address", "t1").record.reply?.lines[0]).toMatch(/grown-up you trust/);
  });

  it("yes without a pending question, or an answer while one is pending, is an ordinary answer", () => {
    expect(decideTurn(awaiting(), "yes", "t1")).toMatchObject({ handled: false });
    const a = decideTurn(awaiting(), "Just tell me the answer.", "t1");
    const b = decideTurn(a.record, "two quarters", "t2");
    expect(b.handled).toBe(false);
    expect(b.record.pending).toBeUndefined();
  });
});
