import { describe, expect, it } from "vitest";
import { TeachingPlanner } from "../TeachingPlanner";
import { VisualDirector } from "../../presentation/VisualDirector";
import { demoPlanningModel, demoTopics } from "./demoModel";
import { numericValue } from "../checks";
import { parseSpokenNumber } from "../numbers";
async function next(p: TeachingPlanner, d: VisualDirector) {
  const step = await p.generate(
    demoPlanningModel,
    d.getSnapshot().canvas,
    () => d.getSnapshot().canvas,
  );
  for (const b of step.beats) {
    const t = d.prepare(b);
    d.narrationStarted(t);
    d.narrationEnded(t);
  }
  p.presented(step.id);
  return step;
}
function correct(p: TeachingPlanner, d: VisualDirector) {
  const s = p.getSnapshot().step!;
  const c = s.check!;
  p.respond(
    {
      eventId: crypto.randomUUID(),
      stepId: s.id,
      response:
        c.kind === "choice"
          ? { kind: "choice", optionId: c.correctOptionId }
          : c.kind === "number"
            ? { kind: "answer", text: String(numericValue(c.rule)) }
            : { kind: "interaction" },
    },
    d.getSnapshot().canvas,
  );
}
describe("offline lesson fixtures", () => {
  it.each(demoTopics)(
    "completes $id through the real planner and canvas",
    async (topic) => {
      const p = new TeachingPlanner({
        sessionId: "demo",
        topic: topic.label,
        originalQuestion: topic.homework,
      });
      const d = new VisualDirector();
      for (let i = 0; i < 12 && p.getSnapshot().status !== "completed"; i++) {
        const s = await next(p, d);
        if (s.check) correct(p, d);
      }
      expect(p.getSnapshot().status).toBe("completed");
      expect(p.recap().independentChecksPassed).toHaveLength(2);
      expect(p.recap().originalQuestion).toBe(topic.homework);
    },
  );
  it("changes representation on request and keeps help as evidence", async () => {
    const p = new TeachingPlanner({
      sessionId: "demo",
      topic: demoTopics[0].label,
    });
    const d = new VisualDirector();
    await next(p, d);
    correct(p, d);
    const first = await next(p, d);
    expect(d.getSnapshot().canvas.math?.visual.kind).toBe("array");
    p.respond(
      {
        eventId: "help",
        stepId: first.id,
        response: { kind: "help", request: "another_way" },
      },
      d.getSnapshot().canvas,
    );
    await next(p, d);
    expect(d.getSnapshot().canvas.activity?.activity.kind).toBe(
      "objects_groups",
    );
    expect(p.getSnapshot().evidence.at(-1)?.outcome).toBe("not_assessed");
  });
  it.each(demoTopics)("repairs an incorrect $id solo answer with a fresh example", async (topic) => {
    const p = new TeachingPlanner({
      sessionId: "demo",
      topic: topic.label,
    });
    const d = new VisualDirector();
    for (let i = 0; i < 8; i++) {
      const s = await next(p, d);
      if (s.phase === "solo") break;
      if (s.check) correct(p, d);
    }
    const old = p.getSnapshot().step!;
    const check = old.check;
    p.respond(
      {
        eventId: "wrong",
        stepId: old.id,
        response: check?.kind === "choice"
          ? { kind: "choice", optionId: check.options.find((o) => o.id !== check.correctOptionId)!.id }
          : { kind: "answer", text: "999" },
      },
      d.getSnapshot().canvas,
    );
    expect((await next(p, d)).phase).toBe("repair");
    correct(p, d);
    const fresh = await next(p, d);
    expect(fresh.phase).toBe("solo");
    expect(fresh.exampleProblem).not.toBe(old.exampleProblem);
  });
  it("does not pretend scripted fixtures cover an unknown topic", async () => {
    const p = new TeachingPlanner({
      sessionId: "demo",
      topic: "Why do magnets attract?",
    });
    await expect(
      demoPlanningModel(p.request(new VisualDirector().getSnapshot().canvas)),
    ).rejects.toThrow("Model endpoint");
  });
});
describe("voice-friendly number checks", () => {
  it.each([
    ["six", 6],
    ["twenty-four.", 24],
    ["one hundred and five", 105],
    ["zero point three five", 0.35],
    ["minus two", -2],
    ["0.4", 0.4],
  ] as const)("reads %s", (text, value) =>
    expect(parseSpokenNumber(text)).toBe(value),
  );
  it.each([
    "maybe six or seven",
    "I don't know",
    "one hundred and",
    "zero point twenty",
    "0x10",
  ])("leaves %s unclear", (text) => expect(parseSpokenNumber(text)).toBeNull());
});
