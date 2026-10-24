import { useState } from "react";
import type { CommandInput } from "../contracts";
import type { MathChange, MathVisual } from "./models";

export function LiveControls({
  visual,
  disabled,
  onCommands,
  onExample,
}: {
  visual: MathVisual;
  disabled: boolean;
  onCommands(commands: CommandInput[], narration: string): void;
  onExample(intent: "simpler" | "variation"): void;
}) {
  const update = (change: MathChange) =>
    onCommands(
      [{ type: "update_math", id: visual.id, change }],
      "The diagram now reflects the updated quantities.",
    );
  return (
    <section className="live-controls" aria-label="Live example controls">
      <h3>Change this example</h3>
      <p>Changes apply to the current picture.</p>
      <fieldset disabled={disabled}>
        {visual.kind === "array" && (
          <>
            <div className="live-fields">
              <label>
                Groups
                <input
                  aria-label="Live groups"
                  type="number"
                  min="1"
                  max="12"
                  value={visual.rows}
                  onChange={(e) => {
                    if (e.target.value !== "")
                      update({
                        type: "set_array",
                        rows: Number(e.target.value),
                      });
                  }}
                />
              </label>
              <label>
                Per group
                <input
                  aria-label="Live objects per group"
                  type="number"
                  min="1"
                  max="20"
                  value={visual.columns}
                  onChange={(e) => {
                    if (e.target.value !== "")
                      onCommands(
                        [
                          {
                            type: "update_math",
                            id: visual.id,
                            change: { type: "set_focus", target: null },
                          },
                          {
                            type: "update_math",
                            id: visual.id,
                            change: {
                              type: "set_array",
                              columns: Number(e.target.value),
                              splitAt:
                                visual.splitAt === null ||
                                Number(e.target.value) < 2
                                  ? null
                                  : Math.min(
                                      visual.splitAt,
                                      Number(e.target.value) - 1,
                                    ),
                            },
                          },
                        ],
                        "The array now uses the updated group size.",
                      );
                  }}
                />
              </label>
            </div>
            <label className="live-check">
              <input
                type="checkbox"
                checked={visual.splitAt !== null}
                onChange={(e) =>
                  onCommands(
                    [
                      {
                        type: "update_math",
                        id: visual.id,
                        change: { type: "set_focus", target: null },
                      },
                      {
                        type: "update_math",
                        id: visual.id,
                        change: {
                          type: "set_array",
                          splitAt: e.target.checked
                            ? Math.max(1, Math.floor(visual.columns / 2))
                            : null,
                        },
                      },
                    ],
                    "Change how the array is divided into parts.",
                  )
                }
                disabled={visual.columns < 2 || disabled}
              />
              Split into parts
            </label>
            {visual.splitAt !== null && (
              <label className="live-range">
                Split after {visual.splitAt}
                <input
                  aria-label="Live split"
                  type="range"
                  min="1"
                  max={visual.columns - 1}
                  value={visual.splitAt}
                  onChange={(e) =>
                    update({
                      type: "set_array",
                      splitAt: Number(e.target.value),
                    })
                  }
                />
              </label>
            )}
          </>
        )}
        {visual.kind === "bars" &&
          visual.bars.map((bar) => (
            <div className="live-bar" key={bar.id}>
              <span>{bar.label}</span>
              <div className="live-fields">
                <label>
                  Parts
                  <input
                    aria-label={`${bar.label} live parts`}
                    type="number"
                    min="1"
                    max="12"
                    value={bar.parts}
                    onChange={(e) => {
                      if (e.target.value !== "")
                        update({
                          type: "set_bar",
                          barId: bar.id,
                          parts: Number(e.target.value),
                          shaded: Math.min(bar.shaded, Number(e.target.value)),
                        });
                    }}
                  />
                </label>
                <label>
                  Coloured
                  <input
                    aria-label={`${bar.label} live shaded`}
                    type="number"
                    min="0"
                    max={bar.parts}
                    value={bar.shaded}
                    onChange={(e) => {
                      if (e.target.value !== "")
                        update({
                          type: "set_bar",
                          barId: bar.id,
                          shaded: Number(e.target.value),
                        });
                    }}
                  />
                </label>
              </div>
            </div>
          ))}
        {visual.kind === "number_line" && (
          <>
            {visual.markers.map((marker) => (
              <label className="live-range" key={marker.id}>
                {marker.label} · {marker.value}
                <input
                  aria-label={`${marker.label} live position`}
                  type="range"
                  min={visual.min}
                  max={visual.max}
                  step={(visual.max - visual.min) / 100}
                  value={marker.value}
                  onChange={(e) =>
                    update({
                      type: "move_marker",
                      markerId: marker.id,
                      value: Number(Number(e.target.value).toFixed(6)),
                    })
                  }
                />
              </label>
            ))}
            <ScaleControls
              key={`${visual.id}:${visual.min}:${visual.max}`}
              visual={visual}
              onApply={(min, max) => update({ type: "set_range", min, max })}
            />
          </>
        )}
        <label className="live-check">
          <input
            type="checkbox"
            checked={visual.showEquation}
            onChange={(e) =>
              update({ type: "set_equation", visible: e.target.checked })
            }
          />
          Show mathematical statement
        </label>
        <label className="live-check">
          <input
            type="checkbox"
            checked={visual.interactive}
            onChange={(e) =>
              update({ type: "set_interaction", enabled: e.target.checked })
            }
          />
          Let the learner manipulate
        </label>
        <label className="live-focus">
          Focus
          <select
            aria-label="Visual focus"
            value={visual.focus ?? ""}
            onChange={(e) =>
              update({
                type: "set_focus",
                target: e.target.value === "" ? null : e.target.value,
              })
            }
          >
            <option value="">Whole picture</option>
            {visual.kind === "array"
              ? visual.splitAt !== null && (
                  <>
                    <option value="left">First part</option>
                    <option value="right">Second part</option>
                  </>
                )
              : (visual.kind === "bars" ? visual.bars : visual.kind === "number_line" ? visual.markers : []).map(
                  (item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ),
                )}
          </select>
        </label>
        <div className="live-example-actions">
          <button onClick={() => onExample("simpler")}>Simpler example</button>
          <button onClick={() => onExample("variation")}>
            Different numbers
          </button>
        </div>
        <small>
          Local example rules use the latest diagram, including learner edits.
          No AI is connected.
        </small>
      </fieldset>
    </section>
  );
}
function ScaleControls({
  visual,
  onApply,
}: {
  visual: Extract<MathVisual, { kind: "number_line" }>;
  onApply(min: number, max: number): void;
}) {
  const [min, setMin] = useState(String(visual.min));
  const [max, setMax] = useState(String(visual.max));
  return (
    <div className="scale-controls">
      <div className="live-fields">
        <label>
          Minimum
          <input
            aria-label="Scale minimum"
            type="number"
            value={min}
            onChange={(e) => setMin(e.target.value)}
          />
        </label>
        <label>
          Maximum
          <input
            aria-label="Scale maximum"
            type="number"
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
        </label>
      </div>
      <button
        disabled={min.trim() === "" || max.trim() === ""}
        onClick={() => onApply(Number(min), Number(max))}
      >
        Apply scale
      </button>
    </div>
  );
}
