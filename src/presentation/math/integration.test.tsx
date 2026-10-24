import { useSyncExternalStore } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fixtureCatalog } from "../../shared/fixtures";
import { TeachingCanvas } from "../TeachingCanvas";
import { VisualDirector } from "../VisualDirector";
import type { BeatInput, PlaybackToken } from "../contracts";
import type { MathAction } from "./models";

const beat: BeatInput = {
  id: "groups",
  narration: "Three groups of fourteen.",
  cues: [
    {
      id: "show",
      atMs: 0,
      commands: [
        {
          type: "show_math",
          visual: {
            kind: "array",
            id: "a",
            title: "Split a multiplication",
            rows: 3,
            columns: 14,
            splitAt: 10,
            showEquation: true,
            interactive: true,
          },
        },
      ],
    },
  ],
};
const action = (overrides: Partial<MathAction> = {}): MathAction => ({
  eventId: "event-1",
  visualId: "a",
  revision: 0,
  change: { type: "set_array", rows: 4 },
  ...overrides,
});
function finish(d: VisualDirector, input: BeatInput = beat) {
  const token = d.prepare(input);
  d.narrationStarted(token);
  d.narrationEnded(token);
  return token;
}
function Host({ director }: { director: VisualDirector }) {
  const s = useSyncExternalStore(director.subscribe, director.getSnapshot);
  return (
    <TeachingCanvas
      canvas={s.canvas}
      interactionEnabled={director.canInteract()}
      onMathAction={(a) => s.token && director.interactMath(s.token, a)}
      onActivityAction={(a) => s.token && director.interactActivity(s.token, a)}
    />
  );
}
describe("unified teaching surface", () => {
  it("lets the child change the same array and derives the displayed equation", () => {
    const d = new VisualDirector();
    finish(d);
    const { container } = render(<Host director={d} />);
    const firstCell = container.querySelector('[data-cell="0-0"]');
    expect(
      screen.getByLabelText("Linked mathematical statement"),
    ).toHaveTextContent("30 + 12 = 42");
    fireEvent.change(screen.getByRole("slider", { name: "Number of groups" }), {
      target: { value: "4" },
    });
    expect(
      screen.getByLabelText("Linked mathematical statement"),
    ).toHaveTextContent("40 + 16 = 56");
    expect(container.querySelector('[data-cell="0-0"]')).toBe(firstCell);
    expect(container.querySelectorAll("[data-cell]")).toHaveLength(56);
  });
  it("keeps learner controls locked while narration is speaking", () => {
    const d = new VisualDirector();
    const token = d.prepare(beat);
    d.narrationStarted(token);
    render(<Host director={d} />);
    expect(
      screen.getByRole("slider", { name: "Number of groups" }),
    ).toBeDisabled();
    act(() => d.narrationEnded(token));
    expect(
      screen.getByRole("slider", { name: "Number of groups" }),
    ).toBeEnabled();
  });
  it("embeds bars and number lines, returning their actions to the director", () => {
    const d = new VisualDirector();
    finish(d, {
      ...beat,
      cues: [
        {
          id: "show",
          atMs: 0,
          commands: [
            {
              type: "show_math",
              visual: {
                id: "b",
                title: "Parts",
                kind: "bars",
                interactive: true,
                showEquation: true,
                bars: [{ id: "half", label: "First", parts: 4, shaded: 1 }],
              },
            },
          ],
        },
      ],
    });
    render(<Host director={d} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Shade 3 of 4 parts in First" }),
    );
    expect(
      screen.getByLabelText("Linked mathematical statement"),
    ).toHaveTextContent("3/4");
    act(() =>
      finish(d, {
        ...beat,
        cues: [
          {
            id: "show",
            atMs: 0,
            commands: [
              {
                type: "show_math",
                visual: {
                  id: "n",
                  title: "Decimals",
                  kind: "number_line",
                  interactive: true,
                  showEquation: true,
                  min: 0,
                  max: 1,
                  markers: [{ id: "p", label: "Point", value: 0.4 }],
                },
              },
            ],
          },
        ],
      }),
    );
    fireEvent.keyDown(screen.getByRole("slider", { name: "Move Point" }), {
      key: "ArrowRight",
    });
    expect(
      screen.getByLabelText("Linked mathematical statement"),
    ).toHaveTextContent("Point: 0.5");
  });
  it("can direct an existing activity on the same surface", () => {
    const d = new VisualDirector();
    finish(d, {
      ...beat,
      cues: [
        {
          id: "show",
          atMs: 0,
          commands: [
            {
              type: "show_activity",
              sceneId: "groups",
              activity: fixtureCatalog.groups,
            },
          ],
        },
      ],
    });
    render(<Host director={d} />);
    expect(
      screen.getByRole("heading", { name: fixtureCatalog.groups.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Learning workspace" }),
    ).toBeInTheDocument();
    const scene = d.getSnapshot().canvas.activity!;
    const response = d.interactActivity(d.getSnapshot().token!, {
      contractVersion: "1.0.0",
      eventId: "place",
      sceneId: scene.sceneId,
      sceneRevision: 0,
      source: "pointer",
      payload: { type: "place", objectId: "seed-1", containerId: "garden-a" },
    });
    expect(response?.scene.placements["seed-1"]).toBe("garden-a");
  });
});
describe("interaction lifecycle", () => {
  it("rejects edits during narration, stale revisions, duplicate events, and old playback runs", () => {
    const d = new VisualDirector();
    const token = d.prepare(beat);
    d.narrationStarted(token);
    expect(d.interactMath(token, action())).toBeNull();
    d.narrationEnded(token);
    expect(d.interactMath(token, action())?.scene.revision).toBe(1);
    expect(d.interactMath(token, action())).toBeNull();
    expect(
      d.interactMath(token, action({ eventId: "old-revision" })),
    ).toBeNull();
    const replay = d.replay() as PlaybackToken;
    d.narrationStarted(replay);
    d.narrationEnded(replay);
    expect(d.getSnapshot().canvas.math?.visual).toMatchObject({ rows: 3 });
    expect(d.interactMath(token, action())).toBeNull();
    expect(d.interactMath(replay, action())?.scene.visual).toMatchObject({
      rows: 4,
    });
  });
  it("does not let learner messages reveal equations, enable interaction, or mutate incompatible models", () => {
    const d = new VisualDirector();
    const token = finish(d);
    expect(
      d.interactMath(
        token,
        action({ change: { type: "set_equation", visible: true } }),
      ),
    ).toBeNull();
    expect(
      d.interactMath(
        token,
        action({ change: { type: "set_array", columns: 3 } }),
      ),
    ).toBeNull();
    expect(d.getSnapshot().canvas.math?.revision).toBe(0);
    d.interrupt(token);
    expect(d.interactMath(token, action())).toBeNull();
  });
  it("preflights future math cues before interrupting an existing explanation", () => {
    const d = new VisualDirector();
    const token = finish(d);
    expect(() =>
      d.prepare({
        ...beat,
        cues: [
          {
            id: "bad",
            atMs: 100,
            commands: [
              {
                type: "update_math",
                id: "a",
                change: { type: "set_array", columns: 2 },
              },
            ],
          },
        ],
      }),
    ).toThrow();
    expect(d.getSnapshot().token).toEqual(token);
  });
});
