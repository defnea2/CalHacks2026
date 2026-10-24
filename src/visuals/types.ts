import type {
  ActionPayload,
  ActivitySpec,
  LearnerAction,
  SceneState,
} from "../shared";

export type EmitAction = (
  payload: ActionPayload,
  source?: LearnerAction["source"],
) => void;
export interface ActivityProps<K extends ActivitySpec["kind"]> {
  activity: Extract<ActivitySpec, { kind: K }>;
  scene: SceneState;
  emit: EmitAction;
  announce(message: string): void;
}
export function isEnabled(scene: SceneState, action: ActionPayload["type"]) {
  return scene.activity.allowedInteractions.includes(action);
}
export function objectClass(scene: SceneState, id: string) {
  return `${scene.selectedIds.includes(id) ? "is-selected" : ""} ${scene.highlightedIds.includes(id) ? "is-highlighted" : ""}`;
}
