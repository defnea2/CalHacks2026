import { describe, expect, it } from "vitest";
import { emptyCanvas, type CanvasState, type VisualBeat } from "../src/presentation/contracts";
import { LessonStreamParser } from "../src/server/streamingLesson";
import { applyLearnerMathAction } from "../src/teaching/interactions";
import {
  acceptStep, answerResponse, buildModelRequest, compileMoment, finalizeLesson, interruptLesson, newLessonRecord, parseBeatInput, parseLessonMeta,
  presented, publicCheck, recordUtterance, respond,
} from "../src/teaching/lessonFlow";
import { miniLessonText, miniMeta, miniMoments, miniSession } from "./fixtures";

/** Streams the fixture through the module-side compiler, beat by beat. */
function compileAll(record = newLessonRecord(miniSession), requestId = "u1") {
  const request = buildModelRequest(record, emptyCanvas(), requestId);
  const meta = parseLessonMeta(request, miniMeta);
  let planned: CanvasState = emptyCanvas();
  const beats: VisualBeat[] = [];
  miniMoments.forEach(({ narration, ...rest }, i) => {
    const final = i === miniMoments.length - 1;
    const { moment } = parseBeatInput(meta, { ...rest, final }, narration);
    const r = compileMoment(meta, moment, i, final, planned);
    beats.push(r.beat);
    planned = r.planned;
  });
  return { request, meta, beats, planned, record };
}

describe("lesson flow (module-side compilation)", () => {
  it("compiles moment by moment exactly like the team's streaming parser", () => {
    const { request, meta, beats, record } = compileAll();
    const parser = new LessonStreamParser(request, () => {});
    parser.push(miniLessonText());
    const teamStep = parser.finish();
    const { step } = finalizeLesson(request, meta, beats, record);
    expect(step).toEqual(teamStep);
    expect(step.beats.at(-1)!.narration).toContain(miniMeta.check.prompt);
    expect(step.id).toBe("step-u1");
  });

  it("accepts a bare compact command as visual and rejects invalid moments with the validator message", () => {
    const request = buildModelRequest(newLessonRecord(miniSession), emptyCanvas(), "u2");
    const meta = parseLessonMeta(request, miniMeta);
    const bare = parseBeatInput(meta, { kind: "keep" }, "Look again.");
    expect(bare).toMatchObject({ final: false, moment: { visual: { kind: "keep" } } });
    expect(() => compileMoment(meta, bare.moment, 0, false, emptyCanvas())).toThrow(/Show a math representation before/);
    expect(() => parseBeatInput(meta, { kind: "bars", bars: [{ id: "a", label: "A", parts: 40, shaded: 1 }] }, "Too many.")).toThrow();
    expect(() => parseBeatInput(meta, [1], "x")).toThrow(/JSON object/);
    // A question inside a narration is rewritten (declarative), as in the team parser.
    const q = parseBeatInput(meta, { kind: "keep" }, "Look here. What do you see?");
    expect(q.moment.narration).toBe("Look here.");
  });

  it("finalize rejects too-short opening lessons (team minimum)", () => {
    const { request, meta, beats, record } = compileAll();
    expect(() => finalizeLesson(request, meta, beats.slice(0, 2), record)).toThrow(/at least 4 connected beats/);
  });

  it("state machine: accept -> presented -> awaiting -> respond -> needs_plan; interrupt and utterances", () => {
    const { request, meta, beats, record, planned } = compileAll();
    const { step, evidence } = finalizeLesson(request, meta, beats, record);
    let r = acceptStep(record, step, evidence);
    expect(r.status).toBe("presenting");
    expect(interruptLesson(r).status).toBe("needs_plan");
    r = presented(r);
    expect(r.status).toBe("awaiting_response");
    expect(publicCheck(r.step!.check)).toEqual({ kind: "explanation", prompt: miniMeta.check.prompt });
    const answered = respond(r, "e1", { kind: "answer", text: "the pieces get smaller but the same part is shaded" }, planned);
    expect(answered.evidence).toMatchObject({ outcome: "unclear", source: "unassessed", stepId: "step-u1" });
    expect(answered.record.status).toBe("needs_plan");
    expect(() => respond(answered.record, "e2", { kind: "answer", text: "x" }, planned)).toThrow(/inactive or unfinished/);
    // Help is always accepted while a step exists.
    expect(respond(answered.record, "e3", { kind: "help", request: "another_way" }, planned).evidence.outcome).toBe("not_assessed");
    // The next request may assess the explanation (team: phaseOptionsAfterAssessment).
    const next = buildModelRequest(answered.record, planned, "u3");
    expect(next.context.phaseOptionsAfterAssessment).not.toBeNull();
    expect(recordUtterance(answered.record, "t1", "hello").config.context.at(-1)).toMatchObject({ text: "hello", source: "learner speech" });
  });

  it("learner math actions follow the director's rules", () => {
    const { planned } = compileAll();
    expect(planned.math!.visual.interactive).toBe(true);
    const ok = applyLearnerMathAction(planned, { eventId: "m1", visualId: "math", revision: planned.math!.revision, change: { type: "set_bar", barId: "whole", parts: 6, shaded: 3 } });
    expect(ok.ok).toBe(true);
    const stale = applyLearnerMathAction(planned, { eventId: "m2", visualId: "math", revision: 0, change: { type: "set_bar", barId: "whole", parts: 6, shaded: 3 } });
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/Stale/) });
    const reveal = applyLearnerMathAction(planned, { eventId: "m3", visualId: "math", revision: planned.math!.revision, change: { type: "set_equation", visible: true } });
    expect(reveal).toMatchObject({ ok: false, error: expect.stringMatching(/cannot set_equation/) });
  });

  it("spoken/typed answers to a choice check select the named option", () => {
    const check = { kind: "choice" as const, prompt: "Which is bigger?", options: [{ id: "a", label: "0.5" }, { id: "b", label: "0.45" }], correctOptionId: "a" };
    expect(answerResponse(check, "I think 0.45")).toEqual({ kind: "choice", optionId: "b" });
    expect(answerResponse(check, "0.5 is bigger")).toEqual({ kind: "choice", optionId: "a" });
    expect(answerResponse(check, "b")).toEqual({ kind: "choice", optionId: "b" });
    expect(answerResponse(check, "both?")).toEqual({ kind: "answer", text: "both?" });
    expect(answerResponse({ kind: "explanation", prompt: "Why?", rubric: ["x"] }, "because")).toEqual({ kind: "answer", text: "because" });
  });
});
