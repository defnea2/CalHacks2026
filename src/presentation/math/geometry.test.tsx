import { useSyncExternalStore } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisualDirector } from "../VisualDirector";
import { TeachingCanvas } from "../TeachingCanvas";
import { assessResponse } from "../../teaching/checks";
import { geometryArea, MathVisualSchema, updateMathVisual } from "./models";
import { mathLatex } from "./MathStatement";

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const d = new VisualDirector();
  const token = d.prepare({ id: "geometry", narration: "Explore area.", cues: [{ id: "show", atMs: 0, commands: [{ type: "show_math", visual: {
    id: "g", title: "Area", kind: "geometry", shape: "right_triangle", width: 6, height: 4, interactive: true, showEquation: true,
  } }] }] });
  d.narrationStarted(token); d.narrationEnded(token);
  return { d, token };
}
function Host({ d }: { d: VisualDirector }) {
  const s = useSyncExternalStore(d.subscribe, d.getSnapshot);
  return <TeachingCanvas canvas={s.canvas} interactionEnabled={d.canInteract()} onMathAction={a => d.interactMath(s.token!, a)} />;
}
describe("local mathematical geometry", () => {
  it("derives area and TeX from the same dimensions and rejects invalid geometry", () => {
    const { d } = setup();
    const v = d.getSnapshot().canvas.math!.visual;
    if (v.kind !== "geometry") throw new Error();
    expect(geometryArea(v)).toBe(12);
    expect(mathLatex(v)).toContain("12");
    expect(() => updateMathVisual(v, { type: "set_geometry", width: 0 })).toThrow();
    expect(() => updateMathVisual(v, { type: "set_geometry", height: 2.3 })).toThrow();
    expect(() => MathVisualSchema.parse({ ...v, focus: "missing" })).toThrow();
  });
  it("changes the displayed geometry locally, assesses actual area and rejects stale edits", () => {
    const { d, token } = setup();
    render(<Host d={d} />);
    expect(screen.getByLabelText("Linked mathematical statement")).toHaveTextContent("12 square units");
    fireEvent.change(screen.getByRole("slider", { name: "Geometry width" }), { target: { value: "8" } });
    expect(screen.getByLabelText("Linked mathematical statement")).toHaveTextContent("16 square units");
    expect(d.getSnapshot().canvas.math?.revision).toBe(1);
    const result = assessResponse({ kind: "math_value", visualId: "g", field: "geometry_area", prompt: "Make an area of 16.", rule: { operation: "value", value: 16 } }, { kind: "interaction" }, d.getSnapshot().canvas);
    expect(result.outcome).toBe("correct");
    expect(d.interactMath(token, { eventId: "stale", visualId: "g", revision: 0, change: { type: "set_geometry", width: 2 } })).toBeNull();
    act(() => d.interrupt(token));
    expect(screen.getByRole("slider", { name: "Geometry width" })).toBeDisabled();
  });
});
