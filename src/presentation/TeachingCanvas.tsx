import { useId } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Icon } from "../visuals/Icon";
import type { CanvasNode, CanvasState } from "./contracts";
import "./presentation.css";

function lines(text: string, width: number, fontSize = 24) {
  const result: string[] = [];
  let line = "";
  const max = Math.max(6, Math.floor(width / (fontSize * 0.53)));
  for (const word of text.split(" ")) {
    if (line && `${line} ${word}`.length > max) {
      result.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) result.push(line);
  return result;
}
function edgePath(from: CanvasNode, to: CanvasNode) {
  const dx = to.x - from.x,
    dy = to.y - from.y;
  const offset = (node: CanvasNode) =>
    Math.min(
      dx === 0 ? Infinity : (node.width / 2 + 12) / Math.abs(dx),
      dy === 0 ? Infinity : (node.height / 2 + 12) / Math.abs(dy),
    );
  if (dx === 0 && dy === 0) return "";
  const start = offset(from),
    end = offset(to);
  return `M ${from.x + dx * start} ${from.y + dy * start} L ${to.x - dx * end} ${to.y - dy * end}`;
}
function NodeContent({ node }: { node: CanvasNode }) {
  const { width: w, height: h } = node;
  if (node.kind === "label")
    return (
      <text className="canvas-large-label" textAnchor="middle">
        {lines(node.label, w, 34).map((line, index) => (
          <tspan key={index} x="0" dy={index === 0 ? 0 : 40}>
            {line}
          </tspan>
        ))}
      </text>
    );
  if (node.kind === "shape")
    return (
      <>
        {node.shape === "circle" ? (
          <ellipse className="canvas-solid" rx={w / 2} ry={h / 2} />
        ) : node.shape === "triangle" ? (
          <polygon
            className="canvas-solid"
            points={`0,${-h / 2} ${w / 2},${h / 2} ${-w / 2},${h / 2}`}
          />
        ) : (
          <rect
            className="canvas-solid"
            x={-w / 2}
            y={-h / 2}
            width={w}
            height={h}
            rx="20"
          />
        )}
        {node.label && (
          <text
            className="canvas-shape-label"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {node.label}
          </text>
        )}
      </>
    );
  return (
    <>
      <rect
        className="canvas-object-paper"
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        rx="28"
      />
      <svg
        x={-w / 2 + 22}
        y={-h / 2 + 18}
        width={w - 44}
        height={Math.max(20, h - (node.label ? 72 : 30))}
        viewBox="0 0 48 48"
      >
        <Icon name={node.icon} className="canvas-icon" />
      </svg>
      <text className="canvas-object-label" textAnchor="middle" y={h / 2 - 30}>
        {lines(node.label, w - 20, 23).map((line, index) => (
          <tspan key={index} x="0" dy={index === 0 ? 0 : 25}>
            {line}
          </tspan>
        ))}
      </text>
    </>
  );
}

export interface TeachingCanvasProps {
  canvas: CanvasState;
  choiceIds?: string[];
  onChoose?(id: string): void;
}
export function TeachingCanvas({
  canvas,
  choiceIds = [],
  onChoose,
}: TeachingCanvasProps) {
  const reduced = useReducedMotion();
  const markerId = `canvas-arrow-${useId().replace(/:/g, "")}`;
  const pointer = canvas.pointer
    ? canvas.nodes.find((node) => node.id === canvas.pointer?.id)
    : null;
  const duration = reduced ? 0 : 0.65;
  return (
    <section className="teaching-canvas" aria-label="Tutor's visual canvas">
      <div className="canvas-heading">
        <span className="canvas-live-dot" />
        <span>Let’s see it together</span>
        <span className="canvas-interaction-hint">
          {choiceIds.length
            ? "Your turn · choose on the canvas"
            : "Follow the explanation"}
        </span>
      </div>
      <h2>{canvas.title}</h2>
      <svg
        className="canvas-surface"
        viewBox="0 0 1000 600"
        aria-label={canvas.title}
        role="group"
      >
        <defs>
          <pattern
            id={`${markerId}-dots`}
            width="28"
            height="28"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="2" cy="2" r="1" fill="#d5dde8" />
          </pattern>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10Z" fill="#8e9bb1" />
          </marker>
        </defs>
        <rect
          width="1000"
          height="600"
          fill={`url(#${markerId}-dots)`}
          opacity=".6"
          rx="24"
        />
        <AnimatePresence>
          {canvas.edges.map((edge) => {
            const from = canvas.nodes.find((node) => node.id === edge.from)!,
              to = canvas.nodes.find((node) => node.id === edge.to)!;
            return (
              <motion.g
                key={edge.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration }}
              >
                <motion.path
                  initial={{ pathLength: reduced ? 1 : 0 }}
                  animate={{ pathLength: 1, d: edgePath(from, to) }}
                  transition={{ duration }}
                  fill="none"
                  stroke="#8e9bb1"
                  strokeWidth="3"
                  markerEnd={`url(#${markerId})`}
                />
                {edge.label && (
                  <text
                    x={(from.x + to.x) / 2}
                    y={(from.y + to.y) / 2 - 16}
                    className="canvas-edge-label"
                    textAnchor="middle"
                  >
                    {edge.label}
                  </text>
                )}
              </motion.g>
            );
          })}
        </AnimatePresence>
        <AnimatePresence>
          {canvas.nodes.map((node) => (
            <motion.g
              key={node.id}
              initial={{
                opacity: 0,
                x: node.x,
                y: node.y,
                scale: reduced ? 1 : 0.8,
              }}
              animate={{
                opacity: 1,
                x: node.x,
                y: node.y,
                scale: 1,
                rotate: node.rotation,
              }}
              exit={{ opacity: 0, scale: reduced ? 1 : 0.85 }}
              transition={{ duration, ease: [0.2, 0.8, 0.2, 1] }}
              className={`canvas-node tone-${node.tone} ${canvas.highlightedIds.includes(node.id) ? "canvas-focused" : ""} ${choiceIds.includes(node.id) ? "canvas-choice" : ""}`}
              role={choiceIds.includes(node.id) ? "button" : "group"}
              aria-label={node.label || node.id}
              tabIndex={choiceIds.includes(node.id) ? 0 : undefined}
              onClick={() => choiceIds.includes(node.id) && onChoose?.(node.id)}
              onKeyDown={(event) => {
                if (
                  choiceIds.includes(node.id) &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault();
                  onChoose?.(node.id);
                }
              }}
            >
              <rect
                className="canvas-focus-ring"
                x={-node.width / 2 - 9}
                y={-node.height / 2 - 9}
                width={node.width + 18}
                height={node.height + 18}
                rx="34"
              />
              <NodeContent node={node} />
            </motion.g>
          ))}
        </AnimatePresence>
        {pointer && canvas.pointer && (
          <motion.g
            className="canvas-pointer"
            initial={false}
            animate={{
              x: pointer.x,
              y:
                pointer.y - pointer.height / 2 < 70
                  ? pointer.y + pointer.height / 2 + 55
                  : pointer.y - pointer.height / 2 - 35,
            }}
            transition={{ duration }}
            aria-hidden="true"
          >
            <rect
              x={
                -Math.min(
                  230,
                  Math.max(65, canvas.pointer.label.length * 6.5 + 25),
                )
              }
              y="-24"
              width={Math.min(
                460,
                Math.max(130, canvas.pointer.label.length * 13 + 50),
              )}
              height="46"
              rx="23"
            />
            <text textAnchor="middle" dominantBaseline="middle">
              {canvas.pointer.label || "Look here"}
            </text>
          </motion.g>
        )}
        {!canvas.nodes.length && (
          <g className="canvas-empty">
            <text x="500" y="270" textAnchor="middle">
              An idea is about to take shape.
            </text>
            <text x="500" y="310" textAnchor="middle">
              Press play to follow along.
            </text>
          </g>
        )}
      </svg>
      <div className="canvas-note" aria-live="polite">
        {canvas.note || "Watch how each new piece connects to the last."}
      </div>
    </section>
  );
}
