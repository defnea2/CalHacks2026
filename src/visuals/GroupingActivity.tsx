import { useState } from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { usePointerDrag } from "../interactions/usePointerDrag";
import { reorderObject } from "../visual-math/geometry";
import { Icon } from "./Icon";
import { isEnabled, objectClass, type ActivityProps } from "./types";

type Props = ActivityProps<"objects_groups" | "sorting_board">;
type Item = { id: string; label: string; icon: string };

function ObjectCard({
  item,
  scene,
  emit,
  announce,
  onHover,
}: Omit<Props, "activity"> & { item: Item; onHover(id: string | null): void }) {
  const reducedMotion = useReducedMotion();
  const drag = usePointerDrag({
    enabled: isEnabled(scene, "place"),
    version: `${scene.sceneId}:${scene.revision}`,
    onPreview: (point) => onHover(point?.targetId ?? null),
    onCancel: () => announce("Move cancelled. The workspace may have changed."),
    onDrop: (point) => {
      if (point.targetId === "unassigned" && isEnabled(scene, "unplace"))
        emit({ type: "unplace", objectId: item.id });
      else if (point.targetId?.startsWith("container:"))
        emit({
          type: "place",
          objectId: item.id,
          containerId: point.targetId.slice(10),
        });
      else
        announce(
          "Drop inside a group, or select the object and use a group’s Place button.",
        );
    },
  });
  return (
    <motion.div
      layout={!reducedMotion && !drag.isDragging}
      className={`lab-token-wrap ${drag.isDragging ? "dragging" : ""}`}
    >
      <button
        {...drag.bindings}
        className={`lab-token ${objectClass(scene, item.id)}`}
        aria-pressed={scene.selectedIds.includes(item.id)}
        aria-label={item.label}
        disabled={!isEnabled(scene, "select") && !isEnabled(scene, "place")}
        style={
          drag.point
            ? {
                translate: `${drag.point.dx}px ${drag.point.dy}px`,
                pointerEvents: "none",
              }
            : undefined
        }
        onClick={(event) =>
          isEnabled(scene, "select") &&
          emit(
            { type: "select", objectId: item.id },
            event.detail === 0 ? "keyboard" : "pointer",
          )
        }
      >
        <Icon name={item.icon} />
        <span>{item.label}</span>
        <span className="drag-grip" aria-hidden="true">
          ⠿
        </span>
      </button>
    </motion.div>
  );
}

export function GroupingActivity({ activity, scene, emit, announce }: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const items =
    activity.kind === "objects_groups" ? activity.objects : activity.items;
  const groups =
    activity.kind === "objects_groups" ? activity.groups : activity.categories;
  const selected = items.find((item) => item.id === scene.selectedIds[0]);
  const unassigned = scene.order.filter((id) => !scene.placements[id]);
  const card = (id: string) => (
    <ObjectCard
      key={id}
      item={items.find((item) => item.id === id)!}
      scene={scene}
      emit={emit}
      announce={announce}
      onHover={setHover}
    />
  );
  return (
    <LayoutGroup id={`${scene.sceneId}-${activity.id}`}>
      <div className="lab-instruction">
        <span className="instruction-number">1</span>
        <span>
          Drag objects into a group, or tap an object and choose{" "}
          <strong>Place here</strong>.
        </span>
      </div>
      <section
        className={`lab-tray ${hover === "unassigned" ? "drop-hover" : ""}`}
        data-drop-target="unassigned"
        aria-label="Objects to explore"
      >
        <div className="lab-section-label">
          <span>Objects to explore</span>
          <span>{unassigned.length} remaining</span>
        </div>
        <div className="lab-token-grid">{unassigned.map(card)}</div>
        {!unassigned.length && (
          <div className="lab-empty">
            Everything has a place. You can still move things around.
          </div>
        )}
      </section>
      <div className="lab-group-grid">
        {groups.map((group, index) => {
          const contents = scene.order.filter(
            (id) => scene.placements[id] === group.id,
          );
          return (
            <section
              key={group.id}
              className={`lab-bin palette-${index % 4} ${hover === `container:${group.id}` ? "drop-hover" : ""}`}
              data-drop-target={`container:${group.id}`}
              aria-label={group.label}
            >
              <div className="lab-bin-heading">
                <h3>{group.label}</h3>
                <span
                  className="count-bubble"
                  aria-label={`${contents.length} objects`}
                >
                  {contents.length}
                </span>
              </div>
              <div className="lab-token-grid">{contents.map(card)}</div>
              {!contents.length && (
                <div className="lab-drop-hint" aria-hidden="true">
                  Drop something here
                </div>
              )}
              <button
                className="lab-place-button"
                disabled={
                  !selected ||
                  !isEnabled(scene, "place") ||
                  scene.placements[selected.id] === group.id
                }
                aria-label={`Place selected object in ${group.label}`}
                onClick={(event) =>
                  selected &&
                  emit(
                    {
                      type: "place",
                      objectId: selected.id,
                      containerId: group.id,
                    },
                    event.detail === 0 ? "keyboard" : "pointer",
                  )
                }
              >
                Place here <span aria-hidden="true">↗</span>
              </button>
            </section>
          );
        })}
      </div>
      <div className="lab-selection-bar">
        <span>
          {selected
            ? `${selected.label} selected`
            : "Select any object to explore it."}
        </span>
        {selected && scene.placements[selected.id] && (
          <button
            disabled={!isEnabled(scene, "unplace")}
            onClick={() => emit({ type: "unplace", objectId: selected.id })}
          >
            Return to tray
          </button>
        )}
        {selected && activity.kind === "sorting_board" && (
          <button
            disabled={
              !isEnabled(scene, "reorder") || scene.order[0] === selected.id
            }
            onClick={() =>
              emit({
                type: "reorder",
                objectIds: reorderObject(
                  scene.order,
                  selected.id,
                  scene.order[0],
                ),
              })
            }
          >
            Move to front
          </button>
        )}
      </div>
    </LayoutGroup>
  );
}
