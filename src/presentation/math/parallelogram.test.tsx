import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { emptyCanvas } from "../contracts";
import { applyCanvasCommands } from "../canvasState";
import { VisualDirector } from "../VisualDirector";
import { MathWorkspace } from "./MathWorkspace";
import { compileMathCommand } from "./compact";
import { MathVisualSchema, mathSummary, updateMathVisual, type MathScene } from "./models";
import { mathLatex } from "./MathStatement";
import { generatePlan, parseModelRequest } from "../../server/planning";
import { TeachingSession } from "../../teaching/TeachingSession";
import type { PlanningModel } from "../../teaching/TeachingPlanner";

vi.mock("motion/react", async original => ({ ...await original<typeof import("motion/react")>(), useReducedMotion: () => true }));
const visual = (patch = {}) => MathVisualSchema.parse({ id: "math", title: "Slant", kind: "parallelogram", base: 6, height: 4, shear: 3, ...patch });

describe("parallelogram visual", () => {
  it("validates shear and proof stages", () => {
    expect(visual()).toMatchObject({ stage: "slant", focus: null, interactive: false });
    expect(() => visual({ shear: 7 })).toThrow(/exceed the base/);
    expect(() => visual({ shear: 0, stage: "cut" })).toThrow(/no triangle/);
    expect(() => visual({ shear: 1.25 })).toThrow();
    const cut = updateMathVisual(visual(), { type: "set_parallelogram", stage: "cut" });
    expect(cut).toMatchObject({ stage: "cut", shear: 3 });
    expect(mathSummary(cut)).toBe("Area = base × height = 6 × 4 = 24 square units");
    expect(mathLatex(cut)).toContain("6 \\times 4 = 24");
  });

  it("compiles compact commands and transforms the same scene", () => {
    let canvas = applyCanvasCommands(emptyCanvas(), compileMathCommand({ kind: "parallelogram", base: 6, height: 4, shear: 0 }, emptyCanvas(), { title: "Slant", interactive: true, showEquation: false }));
    canvas = applyCanvasCommands(canvas, compileMathCommand({ kind: "update", changes: [{ type: "set_parallelogram", shear: 4 }, { type: "set_parallelogram", stage: "cut" }] }, canvas, { title: "Slant", interactive: false, showEquation: false }));
    expect(canvas.math?.visual).toMatchObject({ kind: "parallelogram", shear: 4, stage: "cut", interactive: false });
  });

  it("lets learners slant only the uncut shape, never change its stage or size", () => {
    const d = new VisualDirector();
    const token = d.prepare({ id: "b", narration: "Slant it.", cues: [{ id: "c", atMs: 0, commands: compileMathCommand({ kind: "parallelogram", base: 6, height: 4, shear: 0 }, emptyCanvas(), { title: "Slant", interactive: true, showEquation: false }) }] });
    d.narrationStarted(token); d.narrationEnded(token);
    const act = (change: object) => d.interactMath(token, { eventId: crypto.randomUUID(), visualId: "math", revision: d.getSnapshot().canvas.math!.revision, change });
    expect(act({ type: "set_parallelogram", stage: "reassembled", shear: 2 })).toBeNull();
    expect(act({ type: "set_parallelogram", base: 3 })).toBeNull();
    expect(act({ type: "set_parallelogram", shear: 2 })).not.toBeNull();
    expect(d.getSnapshot().canvas.math?.visual).toMatchObject({ shear: 2, base: 6, stage: "slant" });
  });

  it("renders stages and hides the area until the equation is revealed", () => {
    const scene = (patch = {}): MathScene => ({ visual: visual({ interactive: true, ...patch }), revision: 0, appliedEventIds: [] });
    const onAction = vi.fn();
    const { rerender } = render(<MathWorkspace scene={scene()} enabled onAction={onAction} />);
    fireEvent.change(screen.getByLabelText("Parallelogram slant"), { target: { value: "5" } });
    expect(onAction.mock.calls[0][0].change).toEqual({ type: "set_parallelogram", shear: 5 });
    rerender(<MathWorkspace scene={scene({ stage: "cut" })} enabled onAction={onAction} />);
    expect(screen.queryByLabelText("Parallelogram slant")).not.toBeInTheDocument();
    expect(document.querySelector(".shear-handle")).toHaveStyle({ display: "none" });
    rerender(<MathWorkspace scene={scene({ stage: "reassembled" })} enabled onAction={onAction} />);
    expect(document.querySelector("[data-piece=wedge]")).toHaveAttribute("data-offset", "6.000");
    expect(screen.getByRole("img", { name: /reassembled into a rectangle/ })).not.toHaveAccessibleName(/area/);
    rerender(<MathWorkspace scene={scene({ stage: "reassembled", showEquation: true })} enabled onAction={onAction} />);
    expect(screen.getByRole("img", { name: /area 24 square units/ })).toBeInTheDocument();
  });
});

describe("generated slant lesson", () => {
  const diagnose = {
    phase: "diagnose", title: "Slanting a rectangle", goal: "Predict whether shear changes area", approach: "introduce", reason: "Find the learner's intuition",
    narration: "Here is a rectangle we can slant.", visual: { kind: "parallelogram", base: 6, height: 4, shear: 0 }, interactive: false, showEquation: false,
    check: { kind: "choice", prompt: "If we slant it, what happens to its area?", options: [{ id: "bigger", label: "It gets bigger" }, { id: "smaller", label: "It gets smaller" }, { id: "same", label: "It stays the same" }], correctOptionId: "same" },
  };
  const intuition = {
    phase: "intuition", title: "Cut and slide", goal: "See that shear preserves area", approach: "continue", reason: "The learner predicted bigger",
    narration: "Watch the top slide sideways while the base and height stay put.", visual: { kind: "update", changes: [{ type: "set_parallelogram", shear: 4 }] }, interactive: false, showEquation: false,
    sequence: [
      { narration: "Cut off the triangle along the height.", visual: { kind: "update", changes: [{ type: "set_parallelogram", stage: "cut" }] }, interactive: false, showEquation: false },
      { narration: "Slide the same triangle across. It fills a rectangle.", visual: { kind: "update", changes: [{ type: "set_parallelogram", stage: "reassembled" }] }, interactive: false, showEquation: true },
    ],
    check: { kind: "explanation", prompt: "Why did the area stay the same?", rubric: ["The triangle moved, nothing added or removed"] },
  };

  it("records the learner's prediction as evidence for the planner, then plays the proof on the same scene", async () => {
    const drafts = [diagnose, intuition];
    const requests: unknown[] = [];
    const model: PlanningModel = async (request, signal) => {
      requests.push(request);
      return generatePlan(parseModelRequest(request), vi.fn().mockResolvedValue(drafts[requests.length - 1]), signal!);
    };
    const session = new TeachingSession({ sessionId: "slant", topic: "Does slanting a rectangle change its area?" }, model);
    expect(await session.plan()).toBe(true);
    expect(session.director.getSnapshot().canvas.math?.visual).toMatchObject({ kind: "parallelogram", stage: "slant", showEquation: false });
    const responded = await session.respond({ kind: "choice", optionId: "bigger" });
    expect(session.getSnapshot().error ?? "").toBe("");
    expect(responded).toBe(true);
    const second = requests[1] as { context: { evidence: { response: unknown; outcome: string }[] } };
    expect(second.context.evidence.at(-1)).toMatchObject({ response: { kind: "choice", optionId: "bigger" }, outcome: "incorrect" });
    while (session.planner.getSnapshot().status === "presenting") session.presentNext();
    expect(session.director.getSnapshot().canvas.math?.visual).toMatchObject({ kind: "parallelogram", shear: 4, stage: "reassembled", showEquation: true });
  });
});
