import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { lazy, Suspense, useEffect, useRef } from "react";
const MathStatement = lazy(() => import("./MathStatement").then(m => ({ default: m.MathStatement })));
const GeometryPicture = lazy(() => import("./GeometryPicture").then(m => ({ default: m.GeometryPicture })));
import { LearningWorkspace } from "../../visuals/LearningWorkspace";
import {
  mathActivity,
  mathSummary,
  type MathAction,
  type MathChange,
  type MathScene,
  type MathVisual,
} from "./models";
import "./math.css";

function ArrayPicture({
  visual, animateChanges,
}: {
  animateChanges: boolean;
  visual: Extract<MathVisual, { kind: "array" }>;
}) {
  const reduced = useReducedMotion();
  const { rows, columns, splitAt, focus } = visual;
  const step = Math.min(100, 800 / columns, 290 / rows);
  const gap = splitAt === null ? 0 : 34;
  const left = (1000 - columns * step - gap) / 2;
  const top = (380 - rows * step) / 2 + 30;
  const transition = { duration: reduced || !animateChanges ? 0 : 0.8 };
  return (
    <svg
      className="math-array"
      viewBox="0 0 1000 440"
      role="img"
      aria-label={`${rows} rows of ${columns}, ${rows * columns} cells${splitAt ? `, split into ${splitAt} and ${columns - splitAt}` : ""}`}
    >
      <text x="500" y="28" textAnchor="middle" className="math-array-caption">
        {rows} groups of {columns}
      </text>
      <AnimatePresence>
        {Array.from({ length: rows }, (_, r) =>
          Array.from({ length: columns }, (_, c) => {
            const right = splitAt !== null && c >= splitAt;
            const active =
              focus === null ||
              focus === "all" ||
              (focus === "right" ? right : !right);
            return (
              <motion.rect
                key={`${r}-${c}`}
                data-cell={`${r}-${c}`}
                initial={{
                  opacity: 0,
                  x: left + c * step + (right ? gap : 0),
                  y: top + r * step,
                }}
                animate={{
                  opacity: active ? 1 : 0.25,
                  x: left + c * step + (right ? gap : 0),
                  y: top + r * step,
                  width: step - 5,
                  height: step - 5,
                  fill: right ? "#efddcc" : "#d3e2d9",
                }}
                exit={{ opacity: 0 }}
                transition={transition}
                rx="1"
                stroke={right ? "#b8723f" : "#24594b"}
                strokeWidth="1.5"
              />
            );
          }),
        )}
      </AnimatePresence>
      {splitAt !== null && (
        <>
          <motion.text
            initial={false}
            animate={{
              x: left + (splitAt * step) / 2,
              y: top + rows * step + 35,
            }}
            transition={transition}
            textAnchor="middle"
            className="math-part-label math-part-first"
          >
            {rows} × {splitAt}
          </motion.text>
          <motion.text
            initial={false}
            animate={{
              x: left + splitAt * step + gap + ((columns - splitAt) * step) / 2,
              y: top + rows * step + 35,
            }}
            transition={transition}
            textAnchor="middle"
            className="math-part-label math-part-second"
          >
            {rows} × {columns - splitAt}
          </motion.text>
        </>
      )}
    </svg>
  );
}

export function MathWorkspace({
  scene,
  enabled,
  onAction,
}: {
  scene: MathScene;
  enabled: boolean;
  onAction?(action: MathAction): void;
}) {
  const visual = scene.visual;
  const canChange = enabled && visual.interactive;
  const lastEvent = scene.appliedEventIds.at(-1);
  const previousEvent = useRef(lastEvent);
  const animateChanges = !lastEvent || lastEvent === previousEvent.current;
  useEffect(() => { previousEvent.current = lastEvent; }, [lastEvent]);
  const emit = (change: MathChange) =>
    onAction?.({
      eventId: crypto.randomUUID(),
      visualId: visual.id,
      revision: scene.revision,
      change,
    });
  const activity = mathActivity(scene, enabled);
  return (
    <div
      className={`math-workspace ${canChange ? "" : "math-observe"}`}
      data-visual-id={visual.id}
    >
      {visual.kind === "geometry" ? <Suspense fallback={<div className="math-geometry-loading" role="status">Opening the geometry tools…</div>}><GeometryPicture visual={visual} enabled={canChange} onChange={emit} animateChanges={animateChanges} /></Suspense> : visual.kind === "array" ? (
        <>
          <ArrayPicture visual={visual} animateChanges={animateChanges} />
          {visual.interactive && (
            <fieldset className="math-controls" disabled={!canChange}>
              <legend>Change the picture</legend>
              <label>
                Groups{" "}
                <input
                  aria-label="Number of groups"
                  type="range"
                  min="1"
                  max="12"
                  value={visual.rows}
                  onChange={(e) =>
                    emit({ type: "set_array", rows: Number(e.target.value) })
                  }
                />
                <output>{visual.rows}</output>
              </label>
              <label>
                In each group{" "}
                <input
                  aria-label="Objects per group"
                  type="range"
                  min={visual.splitAt === null ? 1 : visual.splitAt + 1}
                  max="20"
                  value={visual.columns}
                  onChange={(e) =>
                    emit({ type: "set_array", columns: Number(e.target.value) })
                  }
                />
                <output>{visual.columns}</output>
              </label>
              {visual.splitAt !== null && (
                <label>
                  Split after{" "}
                  <input
                    aria-label="Array split"
                    type="range"
                    min="1"
                    max={visual.columns - 1}
                    value={visual.splitAt}
                    onChange={(e) =>
                      emit({
                        type: "set_array",
                        splitAt: Number(e.target.value),
                      })
                    }
                  />
                  <output>{visual.splitAt}</output>
                </label>
              )}
            </fieldset>
          )}
        </>
      ) : (
        activity && (
          <LearningWorkspace
            showComparisonControl={false}
            embedded
            scene={activity}
            onAction={(action) => {
              const p = action.payload;
              if (p.type === "set_parts")
                emit({ type: "set_bar", barId: p.objectId, parts: p.parts });
              if (p.type === "set_shaded")
                emit({ type: "set_bar", barId: p.objectId, shaded: p.shaded });
              if (p.type === "move_marker")
                emit({
                  type: "move_marker",
                  markerId: p.objectId,
                  value: p.value,
                });
            }}
          />
        )
      )}
      {visual.showEquation && <Suspense fallback={<output className="math-equation" aria-label="Linked mathematical statement">{mathSummary(visual)}</output>}><MathStatement visual={visual} /></Suspense>}
    </div>
  );
}
