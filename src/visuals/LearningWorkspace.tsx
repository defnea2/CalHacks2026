import { useEffect, useRef, useState } from "react";
import { MotionConfig, motion, useReducedMotion } from "motion/react";
import { createAction } from "../interactions/createAction";
import {
  SceneStateSchema,
  type LearnerAction,
  type SceneState,
} from "../shared";
import { GroupingActivity } from "./GroupingActivity";
import { BarsActivity } from "./BarsActivity";
import { DiagramActivity } from "./DiagramActivity";
import { NumberLineActivity } from "./NumberLineActivity";
import { ShapeActivity } from "./ShapeActivity";
import type { EmitAction } from "./types";
import "./visuals.css";

export interface LearningWorkspaceProps {
  scene: SceneState;
  embedded?: boolean;
  showComparisonControl?: boolean;
  onAction(action: LearnerAction): void;
}
const typeLabels = {
  objects_groups: "Objects & groups",
  bars_number_line: "Numbers & quantities",
  diagram_sequence: "Connections & sequences",
  shape_workspace: "Shapes & space",
  sorting_board: "Sort & discover",
};

function ValidWorkspace({
  scene,
  onAction,
  embedded = false,
  showComparisonControl = true,
}: LearningWorkspaceProps) {
  const activity = scene.activity;
  const reduce = useReducedMotion();
  const [notice, setNotice] = useState("");
  const previous = useRef(`${scene.sceneId}:${scene.revision}`);
  useEffect(() => {
    const version = `${scene.sceneId}:${scene.revision}`;
    if (previous.current !== version) setNotice("Workspace updated.");
    previous.current = version;
  }, [scene.sceneId, scene.revision]);
  const emit: EmitAction = (payload, source = "pointer") =>
    onAction(createAction(scene, payload, source));
  return (
    <section
      className={`learning-workspace ${embedded ? "lab-embedded" : ""}`}
      aria-label="Learning workspace"
    >
      {!embedded && (
        <>
          <div className="lab-workspace-head">
            <span className="lab-kicker">
              <i />
              {typeLabels[activity.kind]}
            </span>
            <span className="lab-live-label">Your space to explore</span>
          </div>
          <h2>{activity.title}</h2>
          <p className="lab-question">{activity.prompt}</p>
        </>
      )}
      <MotionConfig reducedMotion="user">
        <motion.div
          key={`${scene.sceneId}:${activity.id}`}
          initial={{ opacity: reduce ? 1 : 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
        >
          {(activity.kind === "objects_groups" ||
            activity.kind === "sorting_board") && (
            <GroupingActivity
              scene={scene}
              emit={emit}
              announce={setNotice}
              activity={activity}
            />
          )}
          {activity.kind === "bars_number_line" &&
            (activity.mode === "bars" ? (
              <BarsActivity
                showComparisonControl={showComparisonControl}
                scene={scene}
                emit={emit}
                announce={setNotice}
                activity={activity}
              />
            ) : (
              <NumberLineActivity
                scene={scene}
                emit={emit}
                announce={setNotice}
                activity={activity}
              />
            ))}
          {activity.kind === "diagram_sequence" && (
            <DiagramActivity
              scene={scene}
              emit={emit}
              announce={setNotice}
              activity={activity}
            />
          )}
          {activity.kind === "shape_workspace" && (
            <ShapeActivity
              scene={scene}
              emit={emit}
              announce={setNotice}
              activity={activity}
            />
          )}
        </motion.div>
      </MotionConfig>
      <p
        className="lab-sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {notice}
      </p>
    </section>
  );
}

export function LearningWorkspace(props: LearningWorkspaceProps) {
  const result = SceneStateSchema.safeParse(props.scene);
  if (!result.success)
    return (
      <section className="learning-workspace lab-invalid" role="alert">
        <h2>This activity needs a small fix</h2>
        <p>The visual description was invalid. Ask the tutor to try again.</p>
        <details>
          <summary>Validation details</summary>
          <ul>
            {result.error.issues.map((issue, index) => (
              <li key={index}>
                {issue.path.join(".")}: {issue.message}
              </li>
            ))}
          </ul>
        </details>
      </section>
    );
  return <ValidWorkspace {...props} scene={result.data} />;
}
