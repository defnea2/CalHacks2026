import { useRef, useState, type RefObject } from "react";
import { usePointerDrag, type DragPoint } from "../interactions/usePointerDrag";
import { clamp } from "../visual-math/geometry";
import { isEnabled, objectClass, type ActivityProps } from "./types";

type Props = ActivityProps<"shape_workspace">;
type Shape = Props["activity"]["shapes"][number];

function ShapePath({ shape }: { shape: Shape }) {
  const half = shape.size / 2;
  if (shape.shape === "circle") return <circle r={half} />;
  if (shape.shape === "triangle")
    return (
      <polygon points={`${-half},${-half} ${half},${half} ${-half},${half}`} />
    );
  return (
    <rect
      x={-half}
      y={-half * 0.65}
      width={shape.size}
      height={shape.size * 0.65}
      rx="1"
    />
  );
}

function ShapeObject({
  shape,
  index,
  scene,
  emit,
  announce,
  board,
}: Omit<Props, "activity"> & {
  shape: Shape;
  index: number;
  board: RefObject<SVGSVGElement | null>;
}) {
  const movedPosition = (point: DragPoint) => {
    // Screen-to-SVG conversion respects responsive viewBox letterboxing and page zoom.
    const matrix = board.current?.getScreenCTM();
    if (!matrix) return { x: shape.x, y: shape.y };
    const inverse = matrix.inverse();
    const start = new DOMPoint(
      point.x - point.dx,
      point.y - point.dy,
    ).matrixTransform(inverse);
    const end = new DOMPoint(point.x, point.y).matrixTransform(inverse);
    return {
      x: Math.round(clamp(shape.x + end.x - start.x, 0, 100)),
      y: Math.round(clamp(shape.y + end.y - start.y, 0, 100)),
    };
  };
  const drag = usePointerDrag({
    enabled: isEnabled(scene, "move"),
    version: `${scene.sceneId}:${scene.revision}`,
    onCancel: () => announce("Shape move cancelled."),
    onDrop: (point) =>
      emit({ type: "move", objectId: shape.id, ...movedPosition(point) }),
  });
  const shown = drag.point ? movedPosition(drag.point) : shape;
  const canSelect = isEnabled(scene, "select");
  const canMove = isEnabled(scene, "move");
  return (
    <g
      {...drag.bindings}
      className={`lab-shape-object palette-${index % 4} ${objectClass(scene, shape.id)} ${drag.isDragging ? "dragging" : ""}`}
      role="button"
      aria-label={`Move or select ${shape.label}`}
      aria-pressed={scene.selectedIds.includes(shape.id)}
      aria-disabled={!canSelect && !canMove}
      tabIndex={canSelect || canMove ? 0 : -1}
      transform={`translate(${shown.x} ${shown.y})`}
      onClick={(event) =>
        canSelect &&
        emit(
          { type: "select", objectId: shape.id },
          event.detail === 0 ? "keyboard" : "pointer",
        )
      }
      onKeyDown={(event) => {
        const step = event.shiftKey ? 10 : 2;
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        if (canMove && event.key in moves) {
          event.preventDefault();
          const [dx, dy] = moves[event.key];
          emit(
            {
              type: "move",
              objectId: shape.id,
              x: clamp(shape.x + dx, 0, 100),
              y: clamp(shape.y + dy, 0, 100),
            },
            "keyboard",
          );
        }
        if (canSelect && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          emit({ type: "select", objectId: shape.id }, "keyboard");
        }
      }}
    >
      <g
        className="lab-shape-geometry"
        transform={`rotate(${shape.rotation}) scale(${shape.reflected ? -1 : 1} 1)`}
      >
        <ShapePath shape={shape} />
      </g>
      <text y={shape.size / 2 + 8} textAnchor="middle">
        {shape.label}
      </text>
    </g>
  );
}

export function ShapeActivity({ activity, scene, emit, announce }: Props) {
  const board = useRef<SVGSVGElement>(null);
  const [mirror, setMirror] = useState(false);
  return (
    <>
      <div className="lab-instruction">
        <span className="instruction-number">1</span>
        <span>
          Move a shape, turn it, or flip it. Use arrow keys to move a focused
          shape.
        </span>
      </div>
      <div className="lab-shape-toolbar">
        <span className="lab-section-label">A space to experiment</span>
        <button
          aria-pressed={mirror}
          onClick={() => setMirror((value) => !value)}
        >
          {mirror ? "Hide mirror" : "Show mirror"}
        </button>
      </div>
      <svg
        ref={board}
        className="lab-shape-board"
        viewBox="-30 -30 160 160"
        aria-label="Shape exploration board"
      >
        <g className="lab-grid" aria-hidden="true">
          {Array.from({ length: 121 }, (_, index) => (
            <circle
              key={index}
              cx={(index % 11) * 10}
              cy={Math.floor(index / 11) * 10}
              r=".35"
            />
          ))}
        </g>
        {mirror && (
          <g aria-hidden="true">
            <line
              className="lab-mirror-line"
              x1="50"
              y1="-20"
              x2="50"
              y2="120"
            />
            {activity.shapes.map((shape, index) => (
              <g
                key={shape.id}
                className={`lab-mirror-ghost palette-${index % 4}`}
                transform={`translate(${100 - shape.x} ${shape.y}) scale(-1 1) rotate(${shape.rotation}) scale(${shape.reflected ? -1 : 1} 1)`}
              >
                <ShapePath shape={shape} />
              </g>
            ))}
          </g>
        )}
        {activity.shapes.map((shape, index) => (
          <ShapeObject
            key={shape.id}
            shape={shape}
            index={index}
            scene={scene}
            emit={emit}
            announce={announce}
            board={board}
          />
        ))}
      </svg>
      {mirror && (
        <p className="lab-mirror-caption">
          The dashed shape shows the reflection across the mirror line.
        </p>
      )}
      <div className="lab-shape-controls">
        {activity.shapes.map((shape, index) => (
          <section
            key={shape.id}
            className={`lab-shape-card palette-${index % 4} ${objectClass(scene, shape.id)}`}
            aria-label={`${shape.label} controls`}
          >
            <div>
              <button
                className="lab-object-title"
                disabled={!isEnabled(scene, "select")}
                aria-pressed={scene.selectedIds.includes(shape.id)}
                onClick={() => emit({ type: "select", objectId: shape.id })}
              >
                {shape.label}
              </button>
              <small>
                {shape.rotation}°{shape.reflected ? " · flipped" : ""}
              </small>
            </div>
            <div>
              <button
                disabled={!isEnabled(scene, "transform")}
                aria-label={`Rotate ${shape.label} 90 degrees`}
                onClick={() =>
                  emit({
                    type: "transform",
                    objectId: shape.id,
                    rotation: (((shape.rotation + 90) % 360) + 360) % 360,
                    reflected: shape.reflected,
                  })
                }
              >
                ↻ Turn
              </button>
              <button
                disabled={!isEnabled(scene, "transform")}
                aria-label={`Flip ${shape.label}`}
                onClick={() =>
                  emit({
                    type: "transform",
                    objectId: shape.id,
                    rotation: shape.rotation,
                    reflected: !shape.reflected,
                  })
                }
              >
                ↔ Flip
              </button>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
