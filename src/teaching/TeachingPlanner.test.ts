import { describe, expect, it } from "vitest";
import { TeachingPlanner } from "./TeachingPlanner";
import { emptyCanvas } from "../presentation/contracts";
import { applyCanvasCommands } from "../presentation/canvasState";
import type { StepInput } from "./contracts";
import { assessResponse, numericValue } from "./checks";

const config = {
  sessionId: "session",
  topic: "Multiplication",
  originalQuestion: "What is 7 times 8?",
};
const base = (id = "diagnose"): StepInput => ({
  id,
  phase: "diagnose",
  learningGoal: "Recognize equal groups",
  approach: "introduce",
  rationale: "Find the starting point.",
  beats: [
    {
      id: id + "-beat",
      narration: "How many are two groups of three?",
      cues: [],
    },
  ],
  check: {
    kind: "number",
    prompt: "How many are two groups of three?",
    rule: { operation: "product", left: 2, right: 3 },
  },
  evidenceToObserve: ["Counts equal groups"],
});
function present(
  planner: TeachingPlanner,
  step = base(),
  canvas = emptyCanvas(),
) {
  const req = planner.request(canvas);
  planner.accept(req.requestId, step, canvas);
  planner.presented(step.id);
}
function answer(planner: TeachingPlanner, text: string, id = "answer") {
  return planner.respond(
    {
      eventId: id,
      stepId: planner.getSnapshot().step!.id,
      response: { kind: "answer", text },
    },
    emptyCanvas(),
  );
}
function miniLesson(id = "mini-lesson"): StepInput {
  const prompt = "How many are two groups of four?";
  return {
    ...base(id), phase: "intuition",
    check: { kind: "number", prompt, rule: { operation: "product", left: 2, right: 4 } },
    beats: [
      { id: `${id}-picture`, narration: "Imagine two shelves. Each shelf holds three books. We can draw the books as two rows, so every row means one shelf.", cues: [
        { id: `${id}-show`, atMs: 0, commands: [{ type: "show_math", visual: { id: "books", kind: "array", title: "Equal groups", rows: 2, columns: 3, showEquation: false } }] },
      ] },
      { id: `${id}-group`, narration: "Here is one book on each shelf, and here are the other two. Both shelves have the same number. That is what equal groups means.", cues: [
        { id: `${id}-split`, atMs: 0, commands: [{ type: "update_math", id: "books", change: { type: "set_array", splitAt: 1 } }] },
      ] },
      { id: `${id}-connect`, narration: "Counting three books and three more gives six. Two times three is a short way to say two groups of three.", cues: [
        { id: `${id}-equation`, atMs: 0, commands: [{ type: "update_math", id: "books", change: { type: "set_equation", visible: true } }] },
      ] },
      { id: `${id}-explain`, narration: "The first number tells us how many groups we have. The second tells us how many objects belong in each group. Multiplying counts all the objects.", cues: [] },
      { id: `${id}-check`, narration: `Now try two shelves with four books each. ${prompt}`, cues: [
        { id: `${id}-practice`, atMs: 0, commands: [{ type: "show_math", visual: { id: "practice-books", kind: "array", title: "Two groups of four", rows: 2, columns: 4, showEquation: false } }] },
      ] },
    ],
  };
}
describe("teaching planner", () => {
  it("teaches a complete visual mini lesson before opening its first check", () => {
    const p = new TeachingPlanner({ ...config, lessonStyle: "mini_lesson" });
    const request = p.request(emptyCanvas());
    expect(request.context.allowedPhases).toEqual(["intuition"]);
    expect(() => p.accept(request.requestId, base(), emptyCanvas())).toThrow("Phase is not supported");
    const lesson = miniLesson();
    p.accept(request.requestId, lesson, emptyCanvas());
    expect(p.getSnapshot().step?.beats).toHaveLength(5);
    expect(() => answer(p, "8")).toThrow("unfinished");
    p.presented(lesson.id);
    expect(answer(p, "8").outcome).toBe("correct");
    expect(p.request(emptyCanvas()).context.allowedPhases).toContain("solo");
  });
  it("rejects a quiz-sized opening and an explanation without visual development", () => {
    const p = new TeachingPlanner({ ...config, lessonStyle: "mini_lesson" });
    const request = p.request(emptyCanvas());
    expect(() => p.accept(request.requestId, { ...base(), phase: "intuition" }, emptyCanvas())).toThrow("Teach before testing");
    const noVisuals = miniLesson();
    noVisuals.beats = noVisuals.beats.map(beat => ({ ...beat, cues: [] }));
    expect(() => p.accept(request.requestId, noVisuals, emptyCanvas())).toThrow("Teach with the picture");
    expect(p.getSnapshot().history).toHaveLength(0);
  });
  it("requires a visual reteaching sequence after a mistake instead of another immediate quiz", () => {
    const p = new TeachingPlanner({ ...config, lessonStyle: "mini_lesson" });
    present(p, miniLesson());
    answer(p, "6");
    const request = p.request(emptyCanvas());
    expect(request.context.allowedPhases).not.toContain("solo");
    expect(() => p.accept(request.requestId, { ...base("retry"), phase: "repair" }, emptyCanvas())).toThrow("at least 3 connected beats");
    const repair = miniLesson("repair");
    repair.phase = "repair";
    repair.approach = "simplify";
    repair.beats = [repair.beats[0], repair.beats[1], repair.beats[4]];
    p.accept(request.requestId, repair, emptyCanvas());
    expect(p.getSnapshot().step?.beats).toHaveLength(3);
  });
  it("routes a request for a smaller step back to teaching and keeps ambiguous answers unscored", () => {
    const p = new TeachingPlanner({ ...config, lessonStyle: "mini_lesson" });
    present(p, miniLesson());
    p.respond({ eventId: "help", stepId: "mini-lesson", response: { kind: "help", request: "simpler" } }, emptyCanvas());
    const request = p.request(emptyCanvas());
    expect(request.context.allowedPhases).toEqual(["intuition", "repair"]);
    expect(() => p.accept(request.requestId, { ...base("too-short"), phase: "intuition" }, emptyCanvas())).toThrow("Teach before testing");
    const unclear = new TeachingPlanner({ ...config, lessonStyle: "mini_lesson" });
    present(unclear, miniLesson());
    expect(answer(unclear, "Maybe, I am not sure").outcome).toBe("unclear");
    expect(unclear.request(emptyCanvas()).context.allowedPhases).toEqual(["intuition"]);
  });
  it("starts with diagnosis, waits for presentation, and distinguishes wrong from unclear", () => {
    const p = new TeachingPlanner(config);
    const r = p.request(emptyCanvas());
    expect(r.context.allowedPhases).toEqual(["diagnose"]);
    expect(r.responseSchema).toHaveProperty("properties");
    p.accept(r.requestId, base(), emptyCanvas());
    expect(() => answer(p, "6")).toThrow("unfinished");
    p.presented("diagnose");
    expect(() => p.request(emptyCanvas())).toThrow("Wait for the learner");
    expect(answer(p, "I think maybe six?").outcome).toBe("unclear");
    expect(p.request(emptyCanvas()).context.allowedPhases).toEqual([
      "diagnose",
    ]);
    const wrong = new TeachingPlanner(config);
    present(wrong);
    expect(answer(wrong, "5").outcome).toBe("incorrect");
    expect(wrong.request(emptyCanvas()).context.allowedPhases).toEqual([
      "diagnose",
      "intuition",
    ]);
  });
  it("preflights broken visuals transactionally", () => {
    const p = new TeachingPlanner(config);
    const r = p.request(emptyCanvas());
    const bad = base();
    bad.beats[0].cues = [
      {
        id: "bad",
        atMs: 0,
        commands: [
          {
            type: "update_math",
            id: "missing",
            change: { type: "set_array", rows: 3 },
          },
        ],
      },
    ];
    expect(() => p.accept(r.requestId, bad, emptyCanvas())).toThrow(
      "Unknown math",
    );
    expect(p.getSnapshot().step).toBeNull();
    expect(p.getSnapshot().history).toHaveLength(0);
  });
  it("rejects stale model results and canvas changes without overwriting learner work", () => {
    const p = new TeachingPlanner(config);
    const old = p.request(emptyCanvas());
    const current = p.request(emptyCanvas());
    expect(() => p.accept(old.requestId, base(), emptyCanvas())).toThrow(
      "Stale",
    );
    const changed = applyCanvasCommands(emptyCanvas(), [
      { type: "note", text: "A learner changed this" },
    ]);
    expect(() => p.accept(current.requestId, base(), changed)).toThrow(
      "Canvas changed",
    );
    expect(p.getSnapshot().step).toBeNull();
  });
  it("deduplicates learner events and rejects ID reuse", () => {
    const p = new TeachingPlanner(config);
    present(p);
    const first = answer(p, "6");
    expect(answer(p, "6")).toEqual(first);
    expect(p.getSnapshot().evidence).toHaveLength(1);
    expect(() => answer(p, "5")).toThrow("different payload");
  });
  it("cannot invent evidence or override deterministic assessment", () => {
    const p = new TeachingPlanner(config);
    present(p);
    answer(p, "5");
    const r = p.request(emptyCanvas());
    expect(() =>
      p.accept(
        r.requestId,
        {
          ...base("next"),
          phase: "intuition",
          assessment: {
            evidenceId: "answer",
            judgement: "supported",
            observation: "Understands it",
          },
        },
        emptyCanvas(),
      ),
    ).toThrow("unassessed explanation");
    expect(p.getSnapshot().evidence[0].outcome).toBe("incorrect");
  });
  it("labels interpretation of an explanation as tentative", () => {
    const p = new TeachingPlanner(config);
    const s = base();
    s.check = {
      kind: "explanation",
      prompt: "How many are two groups of three?",
      rubric: ["Mentions adding three twice"],
    };
    present(p, s);
    answer(p, "Three and another three");
    const r = p.request(emptyCanvas());
    p.accept(
      r.requestId,
      {
        ...base("intuition"),
        phase: "intuition",
        assessment: {
          evidenceId: "answer",
          judgement: "supported",
          observation: "Mentions two equal groups.",
        },
      },
      emptyCanvas(),
    );
    expect(p.getSnapshot().evidence[0].source).toBe("model_tentative");
    expect(p.recap().independentChecksPassed).toEqual([]);
  });
  it("leaves the original question unsolved and requires a fresh solo problem", () => {
    const p = new TeachingPlanner(config);
    present(p);
    answer(p, "6");
    const r = p.request(emptyCanvas());
    const next = {
      ...base("solo"),
      phase: "solo" as const,
      exampleProblem: config.originalQuestion,
    };
    expect(() => p.accept(r.requestId, next, emptyCanvas())).toThrow(
      "separate example",
    );
    p.accept(
      r.requestId,
      { ...next, exampleProblem: "What is 3 times 4?" },
      emptyCanvas(),
    );
    p.presented("solo");
    answer(p, "6", "solo-answer");
    const t = p.request(emptyCanvas());
    expect(() =>
      p.accept(
        t.requestId,
        {
          ...base("transfer"),
          phase: "transfer",
          exampleProblem: "What is 3 times 4?",
        },
        emptyCanvas(),
      ),
    ).toThrow("fresh independent");
    expect(p.recap().independentChecksPassed[0].evidenceId).toBe("solo-answer");
  });
  it("requires a real representation change and hides independent-check equations", () => {
    const p = new TeachingPlanner(config);
    present(p);
    answer(p, "6");
    const r = p.request(emptyCanvas());
    expect(() =>
      p.accept(
        r.requestId,
        {
          ...base("different"),
          phase: "intuition",
          approach: "change_representation",
        },
        emptyCanvas(),
      ),
    ).toThrow("representation family");
    const next = base("solo");
    next.phase = "solo";
    next.exampleProblem = "Find 2 times 3.";
    next.beats[0].cues = [
      {
        id: "show",
        atMs: 0,
        commands: [
          {
            type: "show_math",
            visual: {
              id: "a",
              kind: "array",
              title: "Try it",
              rows: 2,
              columns: 3,
              showEquation: true,
            },
          },
        ],
      },
    ];
    expect(() => p.accept(r.requestId, next, emptyCanvas())).toThrow(
      "Hide the derived answer",
    );
    next.beats[0].cues.push({
      id: "hide-later",
      atMs: 1000,
      commands: [{ type: "clear", title: "Now answer" }],
    });
    expect(() => p.accept(r.requestId, next, emptyCanvas())).toThrow(
      "Hide the derived answer",
    );
  });
  it("rejects cancelled asynchronous results", async () => {
    const p = new TeachingPlanner(config);
    const controller = new AbortController();
    await expect(
      p.generate(
        async () => {
          controller.abort();
          return base();
        },
        emptyCanvas(),
        emptyCanvas,
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(p.getSnapshot().step).toBeNull();
  });
});
describe("objective checks", () => {
  it("computes arithmetic and compares submitted quantities", () => {
    expect(numericValue({ operation: "product", left: 3, right: 14 })).toBe(42);
    const canvas = applyCanvasCommands(emptyCanvas(), [
      {
        type: "show_math",
        visual: {
          id: "bar",
          kind: "bars",
          title: "Half",
          bars: [{ id: "b", label: "Bar", parts: 4, shaded: 2 }],
        },
      },
    ]);
    expect(
      assessResponse(
        {
          kind: "math_value",
          prompt: "Make a half",
          visualId: "bar",
          field: "bar_amount",
          itemId: "b",
          rule: { operation: "quotient", left: 1, right: 2 },
        },
        { kind: "interaction" },
        canvas,
      ),
    ).toMatchObject({ outcome: "correct", observedValue: 0.5 });
  });
});
