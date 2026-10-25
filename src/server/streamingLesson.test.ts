// @vitest-environment node
import { describe, expect, it } from "vitest";
import { TeachingPlanner } from "../teaching/TeachingPlanner";
import { emptyCanvas } from "../presentation/contracts";
import { parseModelRequest } from "./planning";
import { LessonStreamParser, sanitizeVisual, fixAssessment } from "./streamingLesson";
import type { PlanningProgress } from "../teaching/streaming";

export const streamedLesson = {
  meta: { phase: "diagnose", title: "A rectangle", goal: "Understand area", approach: "introduce", reason: "Ask for a prediction",
    check: { kind: "number", prompt: "How many squares are inside now?", rule: { operation: "product", left: 4, right: 3 } },
    assessment: null },
  moments: [
    { visual: { kind: "geometry", shape: "rectangle", width: 2, height: 3 }, interactive: false, showEquation: false, narration: "Look at this rectangle." },
    { visual: { kind: "update", changes: [{ type: "set_geometry", width: 4 }] }, interactive: true, showEquation: false, narration: "Its width has increased." },
  ],
};
export function streamingRequest() {
  return parseModelRequest(new TeachingPlanner({ sessionId: "stream", topic: "Area" }).request(emptyCanvas()));
}
describe("progressive mathematical lesson preflight", () => {
  it("speaks the first moment as soon as it compiles, long before the check is generated", () => {
    const request = parseModelRequest(new TeachingPlanner({ sessionId: "mini", topic: "Equivalent fractions", lessonStyle: "mini_lesson" }).request(emptyCanvas()));
    const meta = { phase: "intuition", title: "Equal shares", goal: "See equivalent fractions", approach: "introduce", reason: "Teach before checking", assessment: null,
      check: { kind: "explanation", prompt: "Why is the shaded amount still the same?", rubric: ["The whole and shaded proportion stay equal"] } };
    const bar = (parts: number, shaded: number, extra = {}) => ({ visual: { kind: "update", changes: [{ type: "set_bar", barId: "whole", parts, shaded }] }, ...extra });
    const moments = [
      { visual: { kind: "bars", bars: [{ id: "whole", label: "One whole", parts: 2, shaded: 1 }] } }, bar(4, 2), bar(6, 3), bar(8, 4, { showEquation: true }), bar(4, 2, { showEquation: true }),
      { visual: { kind: "keep" }, interactive: true },
    ].map((m, i) => ({ ...m, narration: ["Start with one whole split into two equal pieces. One of these pieces is shaded, so one half is shaded.",
      "Split each piece into two smaller pieces. There are now four pieces, and two are shaded. The shaded length has not grown.",
      "This time each half contains three little pieces. Three out of six is still one half because we only changed the divisions.",
      "Eight equal pieces work too. Four of them cover exactly the same shaded length. More pieces means each piece is smaller.",
      "Return to quarters. The bottom number counts equal pieces in the whole; the top number counts the pieces we shaded.",
      "These fractions use different numbers to describe the same amount. You can change the picture now and explain what stays the same."][i] }));
    const events: PlanningProgress[] = [];
    const parser = new LessonStreamParser(request, event => events.push(event));
    const text = JSON.stringify({ meta, moments });
    const first = text.indexOf('},{"visual"') + 2; // comma after moment one
    parser.push(text.slice(0, first - 1));
    expect(events).toEqual([]); // the comma proves moment one is not final
    parser.push(text.slice(first - 1, first + 1));
    expect(events.map(event => event.type)).toEqual(["blueprint", "beat"]);
    expect(events[0]).toMatchObject({ blueprint: { open: true } });
    expect((events[0] as { blueprint: { beats: unknown[] } }).blueprint.beats).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("blueprint.beats.0.narration");
    parser.push(text.slice(first + 1));
    expect(events.filter(event => event.type === "beat")).toHaveLength(5); // final moment waits for completion
    const step = parser.finish();
    expect(step.beats).toHaveLength(6);
    expect(step.beats.slice(0, -1).every(beat => !beat.narration.includes("?"))).toBe(true);
    expect(step.beats.at(-1)?.narration).toContain(meta.check.prompt);
    expect(events.filter(event => event.type === "beat")).toHaveLength(6);
    expect(events.filter(event => event.type === "blueprint")).toHaveLength(1);
  });
  it("handles byte-sized chunks, quoted strings and braces inside narration", () => {
    const parser = new LessonStreamParser(streamingRequest(), () => {});
    const input = structuredClone(streamedLesson);
    input.moments[0].narration = 'Say "rectangle" and look at {this}.';
    for (const character of JSON.stringify(input)) parser.push(character);
    expect(parser.finish().beats[0].narration).toBe(input.moments[0].narration);
  });
  it("truncates at the last valid moment when a later visual cannot compile, closing with the check", () => {
    const input = structuredClone(streamedLesson);
    input.moments[1].visual.changes![0].width = 100;
    const events: PlanningProgress[] = [];
    const parser = new LessonStreamParser(streamingRequest(), e => events.push(e));
    parser.push(JSON.stringify(input));
    const step = parser.finish();
    expect(step.beats).toHaveLength(2);
    expect(step.beats[0].narration).toBe("Look at this rectangle.");
    expect(step.beats[1].narration).toContain(streamedLesson.meta.check.prompt);
    expect(events.filter(e => e.type === "beat").map(e => (e as { index: number }).index)).toEqual([0, 1]);
  });
  it("never recovers when the first moment is invalid (caller repairs instead)", () => {
    const input = structuredClone(streamedLesson);
    input.moments[0].visual = { kind: "geometry", shape: "rectangle", width: 100, height: 3 } as never;
    expect(() => new LessonStreamParser(streamingRequest(), () => {}).push(JSON.stringify(input))).toThrow();
  });
  it("widens a number line to hold its markers and renames duplicate ids", () => {
    const v = sanitizeVisual({ kind: "number_line", min: 0, max: 1, markers: [{ id: "a", label: "a", value: 0.5 }, { id: "a", label: "b", value: 3 }] } as never) as never as { min: number; max: number; markers: { id: string }[] };
    expect([v.min, v.max]).toEqual([0, 3]);
    expect(new Set(v.markers.map(m => m.id)).size).toBe(2);
    expect(sanitizeVisual({ kind: "bars", bars: [{ id: "x", label: "x", parts: 4, shaded: 6 }] } as never)).toMatchObject({ bars: [{ shaded: 4 }] });
  });
  it("drops an assessment that cites no assessable explanation instead of failing the spoken lesson", () => {
    const withBad = { ...streamedLesson.meta, assessment: { evidenceId: "made-up", judgement: "supported", observation: "x" } };
    expect(fixAssessment(streamingRequest(), withBad as never).assessment).toBeNull();
    const events: PlanningProgress[] = [];
    const parser = new LessonStreamParser(streamingRequest(), e => events.push(e));
    parser.push(JSON.stringify({ ...streamedLesson, meta: withBad }));
    expect(parser.finish().assessment).toBeNull();
  });
  it("pads an opening mini lesson that arrived one moment short without touching spoken beats", () => {
    const request = parseModelRequest(new TeachingPlanner({ sessionId: "short", topic: "Fractions", lessonStyle: "mini_lesson" }).request(emptyCanvas()));
    const bar = (parts: number, shaded: number) => ({ visual: { kind: "update", changes: [{ type: "set_bar", barId: "w", parts, shaded }] } });
    const moments = [{ visual: { kind: "bars", bars: [{ id: "w", label: "Whole", parts: 2, shaded: 1 }] } }, bar(4, 2), bar(6, 3)]
      .map((m, i) => ({ ...m, narration: ["One half is shaded.", "Four parts, two shaded.", "Six parts, three shaded: still the same amount."][i] }));
    const meta = { phase: "intuition", title: "Halves", goal: "Equivalent fractions", approach: "introduce", reason: "r", assessment: null,
      check: { kind: "explanation", prompt: "Why is it the same?", rubric: ["same whole"] } };
    const events: PlanningProgress[] = [];
    const parser = new LessonStreamParser(request, e => events.push(e));
    parser.push(JSON.stringify({ meta, moments }));
    const step = parser.finish();
    expect(step.beats.length).toBeGreaterThanOrEqual(4);
    expect(step.beats[0].narration).toBe("One half is shaded.");
    expect(step.beats.at(-1)!.narration).toContain("Why is it the same?");
    expect(events.filter(e => e.type === "beat")).toHaveLength(step.beats.length);
  });
  it("releases a moment on the next separator and holds the final one for completion", () => {
    const events: PlanningProgress[] = [];
    const parser = new LessonStreamParser(streamingRequest(), e => events.push(e));
    const [head, tail] = JSON.stringify(streamedLesson).split('},{"visual"');
    parser.push(head + "}");
    expect(events).toHaveLength(0);
    parser.push(',{"visual"' + tail);
    expect(events.map(e => e.type)).toEqual(["blueprint", "beat"]);
    const step = parser.finish();
    expect(events).toHaveLength(3);
    expect(step.beats[1].narration).toContain(streamedLesson.meta.check.prompt);
  });
  it("tolerates stray top-level interactive/showEquation flags after the moments", () => {
    const parser = new LessonStreamParser(streamingRequest(), () => {});
    parser.push(JSON.stringify(streamedLesson).slice(0, -1) + ',"interactive":false,"showEquation":false}');
    expect(parser.finish().beats).toHaveLength(2);
  });
  it("accepts a code fence or trailing words after the complete object", () => {
    const parser = new LessonStreamParser(streamingRequest(), () => {});
    parser.push("```json\n" + JSON.stringify(streamedLesson) + "\n```\nHope this helps.");
    expect(parser.finish().beats).toHaveLength(2);
  });
  it("plays a complete reply whose keys arrive in another order", () => {
    const events: PlanningProgress[] = [];
    const parser = new LessonStreamParser(streamingRequest(), e => events.push(e));
    parser.push(JSON.stringify({ moments: streamedLesson.moments, meta: streamedLesson.meta }));
    expect(events).toHaveLength(0);
    expect(parser.finish().beats).toHaveLength(2);
    expect(events.map(e => e.type)).toEqual(["blueprint", "beat", "beat"]);
  });
  it("ignores unknown top-level keys and turns a stray narration question into a statement", () => {
    const input = structuredClone(streamedLesson) as Record<string, unknown> & typeof streamedLesson;
    input.moments[0].narration = "Look at this rectangle. How many squares are there?";
    input.moments[1].narration = "Is it bigger?";
    const events: PlanningProgress[] = [];
    const parser = new LessonStreamParser(streamingRequest(), e => events.push(e));
    parser.push(JSON.stringify({ ...input, _note: "x", sequence: null }));
    const step = parser.finish();
    expect(step.beats[0].narration).toBe("Look at this rectangle.");
    expect(step.beats[1].narration.startsWith("Is it bigger. ")).toBe(true);
    expect(events.filter(e => e.type === "beat")).toHaveLength(2);
  });
  it("rejects truncation, missing narration, duplicate fields and too many moments", () => {
    const noNarration = structuredClone(streamedLesson) as { moments: { narration?: string }[] };
    delete noNarration.moments[0].narration;
    for (const text of [JSON.stringify(streamedLesson).slice(0, -2), JSON.stringify(noNarration),
      JSON.stringify(streamedLesson).slice(0, -1) + ',"meta":{}}']) {
      const parser = new LessonStreamParser(streamingRequest(), () => {});
      expect(() => { parser.push(text); parser.finish(); }).toThrow();
    }
  });
});
