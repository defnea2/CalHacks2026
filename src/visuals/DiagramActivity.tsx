import { useEffect, useId, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { usePointerDrag } from "../interactions/usePointerDrag";
import { useElementWidth } from "../interactions/useElementWidth";
import {
  connectionPath,
  diagramLayout,
  reorderObject,
} from "../visual-math/geometry";
import { Icon } from "./Icon";
import { isEnabled, objectClass, type ActivityProps } from "./types";

type Props = ActivityProps<"diagram_sequence">;
type Node = Props["activity"]["nodes"][number];

function DiagramNode({
  node,
  index,
  position,
  width,
  scene,
  emit,
  announce,
  onSelect,
  onHover,
}: Omit<Props, "activity"> & {
  node: Node;
  index: number;
  position: { x: number; y: number };
  width: number;
  onSelect(): void;
  onHover(id: string | null): void;
}) {
  const reducedMotion = useReducedMotion();
  const drag = usePointerDrag({
    enabled: isEnabled(scene, "reorder"),
    version: `${scene.sceneId}:${scene.revision}`,
    onPreview: (value) => onHover(value?.targetId ?? null),
    onCancel: () => announce("Reordering cancelled."),
    onDrop: (value) => {
      if (value.targetId?.startsWith("node:"))
        emit({
          type: "reorder",
          objectIds: reorderObject(
            scene.order,
            node.id,
            value.targetId.slice(5),
          ),
        });
      else announce("Drop on another stage to change the order.");
    },
  });
  return (
    <motion.div
      className={`lab-diagram-node ${drag.isDragging ? "dragging" : ""} ${objectClass(scene, node.id)}`}
      data-drop-target={`node:${node.id}`}
      initial={false}
      animate={{ left: `${position.x / 10}%`, top: position.y }}
      transition={{ duration: reducedMotion ? 0 : 0.22 }}
      style={{ width, marginLeft: -width / 2, marginTop: -75 }}
    >
      <button
        {...drag.bindings}
        className="lab-node-main"
        aria-pressed={scene.selectedIds.includes(node.id)}
        aria-label={node.label}
        disabled={
          !isEnabled(scene, "select") &&
          !isEnabled(scene, "reorder") &&
          !isEnabled(scene, "connect")
        }
        onClick={onSelect}
        style={
          drag.point
            ? {
                translate: `${drag.point.dx}px ${drag.point.dy}px`,
                pointerEvents: "none",
              }
            : undefined
        }
      >
        <span className="lab-stage-number">{index + 1}</span>
        <Icon name={node.icon} />
        <span title={node.label}>{node.label}</span>
      </button>
      <div className="lab-node-order">
        <button
          aria-label={`Move ${node.label} earlier`}
          disabled={!isEnabled(scene, "reorder") || index === 0}
          onClick={() =>
            emit(
              {
                type: "reorder",
                objectIds: reorderObject(
                  scene.order,
                  node.id,
                  scene.order[index - 1],
                ),
              },
              "keyboard",
            )
          }
        >
          ←
        </button>
        <span>Move stage</span>
        <button
          aria-label={`Move ${node.label} later`}
          disabled={
            !isEnabled(scene, "reorder") || index === scene.order.length - 1
          }
          onClick={() =>
            emit(
              {
                type: "reorder",
                objectIds: reorderObject(
                  scene.order,
                  node.id,
                  scene.order[index + 1],
                ),
              },
              "keyboard",
            )
          }
        >
          →
        </button>
      </div>
    </motion.div>
  );
}

export function DiagramActivity({ activity, scene, emit, announce }: Props) {
  const { ref, width } = useElementWidth();
  const columns = Math.min(
    activity.nodes.length,
    width < 480 ? 1 : width < 880 ? 2 : 3,
  );
  const layout = diagramLayout(scene.order, columns);
  const cardWidth = Math.min(215, width / columns - 54);
  const markerId = `arrow-${useId().replace(/:/g, "")}`;
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const selected = activity.nodes.find(
    (node) => node.id === scene.selectedIds[0],
  );
  useEffect(() => {
    if (connectFrom && !activity.nodes.some((node) => node.id === connectFrom))
      setConnectFrom(null);
  }, [activity.nodes, connectFrom]);
  const connect = (target: string) => {
    if (!connectFrom || target === connectFrom) return;
    emit({ type: "connect", from: connectFrom, to: target });
    setConnectFrom(null);
  };
  return (
    <div
      onKeyDown={(event) => {
        if (event.key === "Escape") setConnectFrom(null);
      }}
    >
      <div className="lab-instruction">
        <span className="instruction-number">1</span>
        <span>
          Drag stages to reorder them. Select a stage to draw a connection.
        </span>
      </div>
      <div
        className={`lab-diagram ${connectFrom ? "connecting" : ""}`}
        ref={ref}
        style={{ height: layout.height }}
        data-hover-node={hover}
      >
        <svg
          className="lab-connections-svg"
          viewBox={`0 0 1000 ${layout.height}`}
          preserveAspectRatio="none"
          aria-label="Connections between stages"
          role="img"
        >
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0L10 5L0 10Z" fill="#6d7e9b" />
            </marker>
          </defs>
          {activity.edges.map((edge) => (
            <g key={edge.id}>
              <path
                d={connectionPath(
                  layout.positions[edge.from],
                  layout.positions[edge.to],
                  ((cardWidth / width) * 1000) / 2 + 12,
                  84,
                )}
                stroke="#6d7e9b"
                strokeWidth="2.5"
                vectorEffect="non-scaling-stroke"
                fill="none"
                markerEnd={`url(#${markerId})`}
              />
              <title>
                {activity.nodes.find((node) => node.id === edge.from)?.label} to{" "}
                {activity.nodes.find((node) => node.id === edge.to)?.label}
                {edge.label ? `: ${edge.label}` : ""}
              </title>
            </g>
          ))}
        </svg>
        {scene.order.map((id, index) => (
          <DiagramNode
            key={id}
            node={activity.nodes.find((node) => node.id === id)!}
            index={index}
            position={layout.positions[id]}
            width={cardWidth}
            scene={scene}
            emit={emit}
            announce={announce}
            onHover={setHover}
            onSelect={() =>
              connectFrom
                ? connect(id)
                : isEnabled(scene, "select") &&
                  emit({ type: "select", objectId: id })
            }
          />
        ))}
      </div>
      <div className="lab-selection-bar">
        <span>
          {connectFrom
            ? "Choose the stage you want to connect to. Escape cancels."
            : selected
              ? `${selected.label} selected`
              : "Try connecting two stages with an arrow."}
        </span>
        {connectFrom ? (
          <button onClick={() => setConnectFrom(null)}>
            Cancel connection
          </button>
        ) : (
          <button
            disabled={!selected || !isEnabled(scene, "connect")}
            onClick={() => selected && setConnectFrom(selected.id)}
          >
            Connect from selected
          </button>
        )}
      </div>
      <ul className="lab-edge-list" aria-label="Connections">
        {activity.edges.map((edge) => (
          <li key={edge.id}>
            <span>
              {activity.nodes.find((node) => node.id === edge.from)?.label}{" "}
              <span aria-hidden="true">→</span>{" "}
              {activity.nodes.find((node) => node.id === edge.to)?.label}
              {edge.label && <small> · {edge.label}</small>}
            </span>
            <button
              disabled={!isEnabled(scene, "disconnect")}
              aria-label={`Remove connection from ${activity.nodes.find((node) => node.id === edge.from)?.label} to ${activity.nodes.find((node) => node.id === edge.to)?.label}`}
              onClick={() => emit({ type: "disconnect", edgeId: edge.id })}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
