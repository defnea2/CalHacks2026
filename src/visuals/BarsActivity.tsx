import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { compareFractions } from "../visual-math/fractions";
import { isEnabled, objectClass, type ActivityProps } from "./types";

export function BarsActivity({
  activity,
  scene,
  emit,
}: ActivityProps<"bars_number_line">) {
  const [compare, setCompare] = useState(false);
  const reduce = useReducedMotion();
  const first = activity.bars[0],
    second = activity.bars[1];
  const comparison =
    first && second
      ? compareFractions(first.shaded, first.parts, second.shaded, second.parts)
      : null;
  return (
    <>
      <div className="lab-instruction">
        <span className="instruction-number">1</span>
        <span>
          All bars are the same whole. Tap a part to colour that much, then
          compare.
        </span>
      </div>
      <div className="lab-bars">
        {activity.bars.map((bar, index) => (
          <section
            key={bar.id}
            className={`lab-bar-card palette-${index % 4} ${objectClass(scene, bar.id)}`}
            aria-label={bar.label}
          >
            <div className="lab-bar-heading">
              <button
                className="lab-object-title"
                disabled={!isEnabled(scene, "select")}
                aria-pressed={scene.selectedIds.includes(bar.id)}
                onClick={() => emit({ type: "select", objectId: bar.id })}
              >
                {bar.label}
              </button>
              <span
                className="lab-fraction"
                aria-label={`${bar.shaded} out of ${bar.parts}`}
              >
                <span>{bar.shaded}</span>
                <span>{bar.parts}</span>
              </span>
            </div>
            <div
              className="lab-fraction-bar"
              role="group"
              aria-label={`${bar.label} equal parts`}
            >
              {Array.from({ length: bar.parts }, (_, part) => (
                <button
                  key={part}
                  className={part < bar.shaded ? "shaded" : ""}
                  style={{ flex: 1 }}
                  disabled={!isEnabled(scene, "set_shaded")}
                  aria-label={`Shade ${part + 1} of ${bar.parts} parts in ${bar.label}`}
                  aria-pressed={part < bar.shaded}
                  onClick={(event) =>
                    emit(
                      {
                        type: "set_shaded",
                        objectId: bar.id,
                        shaded: part + 1,
                      },
                      event.detail === 0 ? "keyboard" : "pointer",
                    )
                  }
                >
                  <span aria-hidden="true">{part + 1}</span>
                </button>
              ))}
            </div>
            <div className="lab-bar-settings">
              <label>
                Equal parts
                <select
                  aria-label={`${bar.label} equal parts`}
                  value={bar.parts}
                  disabled={!isEnabled(scene, "set_parts")}
                  onChange={(e) =>
                    emit({
                      type: "set_parts",
                      objectId: bar.id,
                      parts: Number(e.target.value),
                    })
                  }
                >
                  {Array.from({ length: 12 }, (_, index) => (
                    <option
                      key={index + 1}
                      value={index + 1}
                      disabled={index + 1 < bar.shaded}
                    >
                      {index + 1}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={!isEnabled(scene, "set_shaded") || bar.shaded === 0}
                onClick={() =>
                  emit({ type: "set_shaded", objectId: bar.id, shaded: 0 })
                }
              >
                Clear colour
              </button>
            </div>
          </section>
        ))}
      </div>
      <button
        className="lab-action"
        onClick={() => setCompare((value) => !value)}
      >
        {compare ? "Hide comparison" : "Compare coloured amounts"}{" "}
        <span aria-hidden="true">↗</span>
      </button>
      {compare && (
        <section className="lab-comparison" aria-label="Equal-scale comparison">
          <span className="lab-section-label">Line them up</span>
          {activity.bars.map((bar, index) => (
            <div
              key={bar.id}
              className={`lab-compare-row palette-${index % 4}`}
            >
              <span>{bar.label}</span>
              <div className="lab-compare-whole">
                <motion.div
                  className="lab-compare-amount"
                  initial={false}
                  animate={{ width: `${(bar.shaded / bar.parts) * 100}%` }}
                  transition={{ duration: reduce ? 0 : 0.25 }}
                />
              </div>
              <span>
                {bar.shaded}/{bar.parts}
              </span>
            </div>
          ))}
          {first && second && (
            <p className="lab-observation">
              {first.shaded}/{first.parts}{" "}
              {comparison === 0 ? "=" : comparison === 1 ? ">" : "<"}{" "}
              {second.shaded}/{second.parts}{" "}
              <small>when the wholes are equal</small>
            </p>
          )}
        </section>
      )}
    </>
  );
}
