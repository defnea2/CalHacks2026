import { expect, it } from "vitest";
import { VisualDirector } from "../VisualDirector";
import { MathVisualSchema } from "./models";
import { createMathExample } from "./examples";
const beat = {
  id: "start",
  narration: "Explore the array.",
  cues: [
    {
      id: "show",
      atMs: 0,
      commands: [
        {
          type: "show_math",
          visual: {
            id: "a",
            kind: "array",
            title: "Multiplication",
            rows: 3,
            columns: 14,
            splitAt: 10,
            interactive: true,
          },
        },
      ],
    },
  ],
};
it("rejects an asynchronous plan based on the state before a learner action", () => {
  const d = new VisualDirector();
  const token = d.prepare(beat);
  d.narrationStarted(token);
  d.narrationEnded(token);
  const before = d.getPlanningContext();
  d.interactMath(token, {
    eventId: "edit",
    visualId: "a",
    revision: 0,
    change: { type: "set_array", rows: 5 },
  });
  expect(() =>
    d.prepare(beat, { expectedContextVersion: before.contextVersion }),
  ).toThrow("Stale teaching plan");
  expect(d.getSnapshot().canvas.math?.visual).toMatchObject({ rows: 5 });
  expect(before.canvas.math?.visual).toMatchObject({ rows: 3 });
  const current = d.getPlanningContext();
  expect(() =>
    d.prepare(beat, { expectedContextVersion: current.contextVersion }),
  ).not.toThrow();
});
it("keeps planning context stable for duplicate audio progress but invalidates it on replay and reset", () => {
  const d = new VisualDirector();
  const token = d.prepare(beat);
  d.narrationStarted(token);
  const version = d.getSnapshot().contextVersion;
  d.narrationProgress(token, 100);
  d.narrationProgress(token, 100);
  expect(d.getSnapshot().contextVersion).toBe(version);
  d.replay();
  expect(d.getSnapshot().contextVersion).toBeGreaterThan(version);
  const replayVersion = d.getSnapshot().contextVersion;
  d.reset();
  expect(d.getSnapshot().contextVersion).toBeGreaterThan(replayVersion);
});
it("creates a new example from the learner's actual quantities and handles bounds", () => {
  const current = MathVisualSchema.parse({
    id: "a",
    kind: "array",
    title: "Array",
    rows: 5,
    columns: 14,
    splitAt: 10,
  });
  expect(createMathExample(current, "variation")).toMatchObject({
    rows: 5,
    columns: 15,
    splitAt: 10,
  });
  expect(createMathExample(current, "simpler")).toMatchObject({
    rows: 3,
    columns: 7,
    splitAt: 6,
  });
  expect(current).toMatchObject({ rows: 5, columns: 14 });
  for (let rows = 1; rows <= 12; rows++)
    for (let columns = 1; columns <= 20; columns++) {
      const v = MathVisualSchema.parse({
        ...current,
        rows,
        columns,
        splitAt: columns > 1 ? columns - 1 : null,
        focus: null,
      });
      for (const intent of ["simpler", "variation"] as const)
        expect(() =>
          MathVisualSchema.parse(createMathExample(v, intent)),
        ).not.toThrow();
    }
});
it("creates valid bar and number-line variants without implying equivalence", () => {
  const bars = MathVisualSchema.parse({
    id: "b",
    title: "Bars",
    kind: "bars",
    bars: [{ id: "b1", label: "One", parts: 12, shaded: 12 }],
  });
  expect(createMathExample(bars, "simpler")).toMatchObject({
    bars: [{ parts: 2, shaded: 1 }],
  });
  const line = MathVisualSchema.parse({
    id: "l",
    title: "Line",
    kind: "number_line",
    min: -1,
    max: 1,
    markers: [{ id: "m", label: "Point", value: 1 }],
  });
  expect(createMathExample(line, "variation")).toMatchObject({
    markers: [{ value: -1 }],
  });
  expect(createMathExample(line, "simpler")).toMatchObject({
    min: 0,
    max: 10,
    markers: [{ value: 10 }],
  });
});
