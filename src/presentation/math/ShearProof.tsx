import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useReducedMotion } from "motion/react";
import {
  clampShear, parallelogram, reassembled, remainder, shapeArea, slantedSide, translate, wedge, wedgeOffset,
  SHEAR_STEP, type Point, type ShearShape,
} from "../../visual-math/shear";
import "./math.css";
import "./shear.css";

const UNIT = 56, LEFT = 44, TOP = 36;
export const SLIDE_MS = 1600;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export type ProofStage = "slant" | "cut" | "reassembled";

export interface ShearProofProps {
  shape: ShearShape;
  stage: ProofStage;
  /** Shear input is only ever accepted on the uncut shape. */
  draggable: boolean;
  onShear(shear: number): void;
  /** Slide the wedge when the stage becomes reassembled; otherwise it appears in place. */
  animate?: boolean;
  onSettled?(): void;
  showArea?: boolean;
  /** The dashed starting rectangle; hidden while a prediction is pending. */
  showOriginal?: boolean;
  caption?: string;
}

/** Deterministic cut-and-slide proof. Pieces keep their geometry; only the wedge's translation animates. */
export function ShearProof({ shape, stage, draggable: canSlant, onShear, animate = true, onSettled, showArea = false, showOriginal = true, caption }: ShearProofProps) {
  const reduced = useReducedMotion();
  const { base: b, height: h, shear: s } = shape;
  const X = (x: number) => LEFT + x * UNIT, Y = (y: number) => TOP + (h - y) * UNIT;
  const path = (points: readonly Point[]) => points.map(([x, y]) => `${X(x)},${Y(y)}`).join(" ");
  const width = LEFT * 2 + b * 2 * UNIT + 120, height = TOP + h * UNIT + 50;
  const draggable = canSlant && stage === "slant";

  // Translation progress: 0 before the slide, 1 once the wedge sits in its new place.
  const [progress, setProgress] = useState(stage === "reassembled" ? 1 : 0);
  const settled = useRef(onSettled); settled.current = onSettled;
  const previous = useRef(stage);
  useEffect(() => {
    const from = previous.current;
    previous.current = stage;
    if (stage !== "reassembled") { setProgress(0); return; }
    if (from === "reassembled") return;
    if (!animate || reduced) { setProgress(1); settled.current?.(); return; }
    const start = performance.now();
    let frame = 0, finished = false;
    setProgress(0);
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / SLIDE_MS);
      setProgress(ease(t));
      if (t < 1) frame = requestAnimationFrame(tick); else { finished = true; settled.current?.(); }
    };
    frame = requestAnimationFrame(tick);
    // An interrupted slide (e.g. StrictMode remount, motion preference change) is played again.
    return () => { cancelAnimationFrame(frame); if (!finished) previous.current = from; };
  }, [stage, animate, reduced]);

  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointer: number; x: number; shear: number } | null>(null);
  useEffect(() => { if (!draggable) drag.current = null; }, [draggable]);
  const setShear = (value: number) => { const next = clampShear(shape, value); if (next !== s) onShear(next); };
  const toUnits = (dx: number) => {
    const rect = svg.current?.getBoundingClientRect();
    return rect && rect.width > 0 ? (dx * width) / rect.width / UNIT : 0;
  };
  const handle = {
    onPointerDown(e: PointerEvent<SVGGElement>) {
      if (!draggable || e.button !== 0) return;
      drag.current = { pointer: e.pointerId, x: e.clientX, shear: s };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove(e: PointerEvent<SVGGElement>) {
      const d = drag.current;
      if (!d || d.pointer !== e.pointerId || !draggable) return;
      e.preventDefault();
      setShear(d.shear + toUnits(e.clientX - d.x));
    },
    onPointerUp() { drag.current = null; },
    onPointerCancel() { drag.current = null; },
    onKeyDown(e: KeyboardEvent<SVGGElement>) {
      if (!draggable) return;
      const step = { ArrowRight: SHEAR_STEP, ArrowUp: SHEAR_STEP, ArrowLeft: -SHEAR_STEP, ArrowDown: -SHEAR_STEP }[e.key];
      const target = e.key === "Home" ? 0 : e.key === "End" ? b : step === undefined ? null : s + step;
      if (target === null) return;
      e.preventDefault();
      setShear(target);
    },
  };

  const piece = wedge(shape), cutting = stage !== "slant";
  const [ox] = wedgeOffset(shape), offset = ox * progress * UNIT;
  const done = stage === "reassembled" && progress === 1;
  const topMid = s + b / 2;
  const text = caption ?? {
    slant: s === 0 ? (draggable ? "Drag the top edge sideways to slant the shape." : "A rectangle.") : "Same base. Same height. Is it the same amount of space?",
    cut: "Cut along the height. The triangle that sticks out is one piece.",
    reassembled: done ? "Nothing added, nothing removed: the pieces make a rectangle." : "Sliding the same triangle across…",
  }[stage];
  return <figure className="shear-proof" data-stage={stage}>
    {text && <figcaption className="shear-caption" aria-live="polite">{text}</figcaption>}
    <svg ref={svg} viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={`Parallelogram with base ${b}, height ${h}, slanted ${s} units${done ? ", reassembled into a rectangle" : ""}${showArea ? `, area ${shapeArea(shape)} square units` : ""}`}>
      <g className="shear-grid" aria-hidden="true">
        {Array.from({ length: Math.floor(b * 2) + 1 }, (_, i) => <line key={`v${i}`} x1={X(i)} x2={X(i)} y1={Y(0)} y2={Y(h)} />)}
        {Array.from({ length: Math.floor(h) + 1 }, (_, i) => <line key={`h${i}`} x1={X(0)} x2={X(b * 2)} y1={Y(i)} y2={Y(i)} />)}
      </g>
      {showOriginal && <polygon className="shear-ghost" points={path([[0, 0], [b, 0], [b, h], [0, h]])} />}
      {!cutting ? <>
        <polygon className="shear-shape" data-piece="parallelogram" points={path(parallelogram(shape))} />
        {s > 0 && <text className="shear-side-label" x={X(b + s / 2) + 12} y={Y(h / 2)}>slanted side ≈ {slantedSide(shape).toFixed(1)}</text>}
      </> : <>
        {stage === "cut" && piece && <polygon className="shear-slot" points={path(translate(piece, wedgeOffset(shape)))} />}
        <polygon className="shear-shape" data-piece="remainder" points={path(remainder(shape))} />
        {piece && <g data-piece="wedge" data-offset={(offset / UNIT).toFixed(3)} transform={`translate(${offset} 0)`}>
          <polygon className="shear-shape shear-wedge" points={path(piece)} />
        </g>}
        {stage === "cut" && <line className="shear-seam" x1={X(s)} x2={X(s)} y1={Y(0) + 10} y2={Y(h) - 10} />}
      </>}
      {s > 0 && <g className="shear-height" aria-hidden="true">
        <line x1={X(s)} x2={X(s)} y1={Y(h)} y2={Y(0)} />
        <path d={`M${X(s)} ${Y(0) - 12}h12v12`} fill="none" />
      </g>}
      <text className="shear-measure" x={done ? X(s) - 12 : X(s) + 12} y={Y(h / 2)} textAnchor={done ? "end" : "start"}>height {h}</text>
      {/* After reassembly the base is the rectangle's bottom edge: same length, shifted with the pieces. */}
      <line className="shear-base" x1={X(done ? s : 0)} x2={X(done ? s + b : b)} y1={Y(0)} y2={Y(0)} />
      <text className="shear-measure" x={X((done ? s : 0) + b / 2)} y={Y(0) + 26} textAnchor="middle">base {b}</text>
      {done && <g className="shear-result">
        <polygon points={path(reassembled(shape))} />
        {showArea && <text x={X(s + b / 2)} y={Y(h / 2) + 8} textAnchor="middle">{b} × {h} = {shapeArea(shape)}</text>}
      </g>}
      <g className="shear-handle" {...handle}
        role="slider" tabIndex={draggable ? 0 : -1} aria-disabled={!draggable}
        aria-label="Slant of the top edge" aria-valuemin={0} aria-valuemax={b} aria-valuenow={s}
        aria-valuetext={`Slanted ${s} of ${b} units`}
        style={{ display: draggable ? undefined : "none" }}>
        <rect className="shear-handle-hit" x={X(topMid) - 44} y={Y(h) - 26} width={88} height={52} rx={26} />
        <rect className="shear-handle-pill" x={X(topMid) - 30} y={Y(h) - 11} width={60} height={22} rx={11} />
        <path d={`M${X(topMid) - 16} ${Y(h)}l6 -5v10z M${X(topMid) + 16} ${Y(h)}l-6 -5v10z`} />
      </g>
    </svg>
  </figure>;
}
