// Lesson arcs: the pack's demo2min arc parses, its policy is deterministic, the worst case stays
// inside the two-minute budget, and the planner prompt carries the arc (system) + stage (data).
import { describe, expect, it } from "vitest";
import { arcs } from "../../shared/src/lesson/pack/arcs";
import { arcBudget, arcMoment, arcPhases, arcPrompt, LessonArcSchema, type LessonArc } from "../src/teaching/arc";
import { allowedPhases } from "../src/teaching/policy";
import { buildModelRequest, newLessonRecord } from "../src/teaching/lessonFlow";
import { plannerSystem, plannerUserMessage } from "../src/server/plannerPrompt";
import { emptyCanvas } from "../src/presentation/contracts";
import type { Evidence, TeachingStep } from "../src/teaching/contracts";

const arc: LessonArc = LessonArcSchema.parse(arcs.demo2min);
const step = (phase: TeachingStep["phase"], check = true) => ({ id: "s", phase, check: check ? { kind: "number", prompt: "?", rule: { operation: "value", value: 1 } } : null }) as unknown as TeachingStep;
const ev = (outcome: Evidence["outcome"], kind: "answer" | "help" = "answer") => ({ outcome, response: kind === "help" ? { kind, request: "explain" } : { kind, text: "x" } }) as unknown as Evidence;

describe("demo2min arc", () => {
  it("parses with the schema; every phase it names is a team phase", () => {
    expect(arc.stages.map(s => s.id)).toEqual(["explain", "repair", "task", "hand_back"]);
  });

  it("policy: explanation first (no diagnosis), a missed task gets one repair, then hand back", () => {
    expect(arcPhases(arc, null, undefined)).toEqual(["intuition"]);
    expect(arcPhases(arc, step("intuition"), ev("correct"))).toEqual(["return_to_problem"]);
    expect(arcPhases(arc, step("intuition"), ev("unclear"))).toEqual(["repair"]);
    expect(arcPhases(arc, step("intuition"), ev("incorrect"))).toEqual(["repair"]);
    expect(arcPhases(arc, step("intuition"), undefined)).toEqual(["repair"]); // cut short / continue
    expect(arcPhases(arc, step("repair"), ev("incorrect"))).toEqual(["return_to_problem"]);
    expect(arcPhases(arc, step("repair"), ev("correct"))).toEqual(["return_to_problem"]);
    expect(arcPhases(arc, step("return_to_problem", false), undefined)).toEqual([]);
    // "Show me" must stay possible (the team validator demands intuition for it).
    expect(arcPhases(arc, step("repair"), ev("not_assessed", "help"))).toEqual(["intuition"]);
    // The team policy delegates to the arc when the session has one.
    expect(allowedPhases(step("intuition"), ev("unclear"), { arc })).toEqual(["repair"]);
    expect(allowedPhases(step("intuition"), ev("unclear"), { lessonStyle: "mini_lesson" })).toEqual(["intuition"]);
  });

  it("budget: explanation, formalization and task are all spoken within two minutes, even in the worst case", () => {
    const b = arcBudget(arc, 5);
    expect(b.withinBudget).toBe(true);
    expect(b.explanation).toBeLessThan(15);
    expect(b.formalization!).toBeLessThan(35);
    expect(b.task).toBeLessThan(60);
    // Worst case through the whole arc (every stage at its word cap + 3 learner turns of ~4 s + ~3 s latency each).
    const words = arc.stages.reduce((n, s) => n + s.maxWords, 0);
    expect(5 + words / arc.wordsPerSecond + 3 * (4 + 3)).toBeLessThan(arc.budgetSeconds + 10);
  });

  it("moment rules: the formalization slot shows the equation; the cap forces the final moment", () => {
    expect(arcMoment(arc, "intuition", 2, false, { showEquation: false })).toEqual({ showEquation: true });
    expect(arcMoment(arc, "intuition", 1, false, { showEquation: false })).toEqual({ showEquation: false });
    expect(arcMoment(arc, "intuition", 2, true, { showEquation: false })).toEqual({ showEquation: false });
    expect(() => arcMoment(arc, "intuition", 4, false, { showEquation: false })).toThrow(/at most 5 moments/);
    expect(arcMoment(undefined, "intuition", 4, false, { showEquation: false })).toEqual({ showEquation: false });
  });

  it("prompt: the arc is in the (cache-stable) system prompt, the data names only the current stage", () => {
    const system = plannerSystem(arc, "LIBRARY INDEX: x");
    expect(system).toContain('LESSON ARC "demo2min"');
    expect(system).toContain("moment 3 is the formalization");
    expect(system.endsWith("LIBRARY INDEX: x")).toBe(true);
    expect(plannerSystem(arc, "LIBRARY INDEX: x")).toBe(system);
    expect(arcPrompt(arc).length).toBeLessThan(4000);
    const request = buildModelRequest(newLessonRecord({ sessionId: "s1", topic: "Expand 2/3", lessonStyle: "mini_lesson", arc }), emptyCanvas(), "r1");
    const user = plannerUserMessage(request, null, { concept: "fractions-expand" });
    const data = JSON.parse(user.slice(user.indexOf("\n") + 1));
    expect(data.session.arc).toBeUndefined();
    expect(data.arcStage).toMatchObject({ stage: "explain", moments: "4-5", formalizeAtMoment: 3, check: "choice or number" });
    expect(data.library).toEqual({ concept: "fractions-expand" });
  });
});
