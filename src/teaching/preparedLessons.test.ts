import { describe, expect, it } from "vitest";
import { VisualDirector } from "../presentation/VisualDirector";
import { numericValue } from "./checks";
import type { LearnerResponse } from "./contracts";
import { TeachingPlanner } from "./TeachingPlanner";
import { preparedLessons, preparedPlanningModel } from "./preparedLessons";

function setup(topic: string) {
  return { planner: new TeachingPlanner({ sessionId: "prepared-test", topic, lessonStyle: "mini_lesson" }), director: new VisualDirector() };
}
async function next({ planner, director }: ReturnType<typeof setup>) {
  const step = await planner.generate(preparedPlanningModel, director.getSnapshot().canvas, () => director.getSnapshot().canvas);
  for (const beat of step.beats) {
    const token = director.prepare(beat);
    director.narrationStarted(token);
    director.narrationEnded(token);
  }
  planner.presented(step.id);
  return step;
}
function respond({ planner, director }: ReturnType<typeof setup>, response?: LearnerResponse["response"]) {
  const step = planner.getSnapshot().step!;
  const check = step.check!;
  planner.respond({ eventId: crypto.randomUUID(), stepId: step.id, response: response ?? (check.kind === "choice" ? { kind: "choice", optionId: check.correctOptionId } : check.kind === "number" ? { kind: "answer", text: String(numericValue(check.rule)) } : { kind: "interaction" }) }, director.getSnapshot().canvas);
}

describe("prepared mini lessons", () => {
  it.each(preparedLessons)("teaches $id before checking, then completes two independent checks", async lesson => {
    const lessonState = setup(lesson.topic);
    const intro = await next(lessonState);
    expect(intro.phase).toBe("intuition");
    expect(intro.beats).toHaveLength(6);
    expect(intro.beats.slice(0, -1).every(beat => !beat.narration.includes(intro.check!.prompt))).toBe(true);
    expect(intro.beats.reduce((words, beat) => words + beat.narration.split(/\s+/).length, 0)).toBeGreaterThan(130);
    respond(lessonState);
    expect((await next(lessonState)).phase).toBe("solo");
    expect(lessonState.director.getSnapshot().canvas.math?.visual.showEquation).toBe(false);
    respond(lessonState);
    expect((await next(lessonState)).phase).toBe("transfer");
    respond(lessonState);
    await next(lessonState);
    expect(lessonState.planner.getSnapshot().status).toBe("completed");
    expect(lessonState.planner.recap().independentChecksPassed).toHaveLength(2);
  });

  it.each(preparedLessons)("reteaches $id after a wrong answer and uses fresh practice", async lesson => {
    const lessonState = setup(lesson.topic);
    await next(lessonState);
    respond(lessonState);
    const original = await next(lessonState);
    const originalKind = lessonState.director.getSnapshot().canvas.math?.visual.kind;
    respond(lessonState, { kind: "answer", text: "999" });
    const reteaching = await next(lessonState);
    expect(reteaching.phase).toBe("intuition");
    expect(reteaching.beats.length).toBeGreaterThanOrEqual(4);
    expect(lessonState.director.getSnapshot().canvas.math?.visual.kind).not.toBe(originalKind);
    respond(lessonState);
    const practice = await next(lessonState);
    expect(practice.phase).toBe("solo");
    expect(practice.exampleProblem).not.toBe(original.exampleProblem);
  });

  it.each(preparedLessons)("changes the $id picture on repeated requests for another way", async lesson => {
    const lessonState = setup(lesson.topic);
    await next(lessonState);
    const initialKind = lessonState.director.getSnapshot().canvas.math?.visual.kind;
    respond(lessonState, { kind: "help", request: "another_way" });
    await next(lessonState);
    expect(lessonState.director.getSnapshot().canvas.math?.visual.kind).not.toBe(initialKind);
    const kinds = [initialKind, lessonState.director.getSnapshot().canvas.math?.visual.kind];
    respond(lessonState, { kind: "help", request: "another_way" });
    await next(lessonState);
    const third = lessonState.director.getSnapshot().canvas.math?.visual.kind;
    expect(kinds).not.toContain(third);
    respond(lessonState, { kind: "help", request: "another_way" });
    await next(lessonState);
    expect(lessonState.director.getSnapshot().canvas.math?.visual.kind).toBe(initialKind);
  });

  it("leaves an unclear numeric response unscored and asks a fresh question", async () => {
    const lessonState = setup(preparedLessons[1].topic);
    await next(lessonState);
    respond(lessonState);
    const before = await next(lessonState);
    respond(lessonState, { kind: "answer", text: "maybe seven or eight" });
    expect(lessonState.planner.getSnapshot().evidence.at(-1)?.outcome).toBe("unclear");
    const after = await next(lessonState);
    expect(after.phase).toBe("solo");
    expect(after.exampleProblem).not.toBe(before.exampleProblem);
  });

  it("repeats independent practice as support, without fabricating new evidence", async () => {
    const lessonState = setup(preparedLessons[0].topic);
    await next(lessonState);
    respond(lessonState);
    const practice = await next(lessonState);
    respond(lessonState, { kind: "help", request: "repeat" });
    const repeated = await next(lessonState);
    expect(repeated.exampleProblem).toBe(practice.exampleProblem);
    expect(repeated.approach).toBe("hint");
    expect(lessonState.planner.getSnapshot().evidence.at(-1)?.outcome).toBe("not_assessed");
  });

  it("does not silently substitute a prepared lesson for an arbitrary topic", async () => {
    const lessonState = setup("How do logarithms work?");
    await expect(next(lessonState)).rejects.toThrow("live tutor");
  });
});
