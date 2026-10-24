export {
  LearningWorkspace,
  type LearningWorkspaceProps,
} from "./LearningWorkspace";
export {
  ActivitySpecSchema,
  SceneStateSchema,
  LearnerActionSchema,
  SceneCommandSchema,
  CONTRACT_VERSION,
  createScene,
} from "../shared";
export type {
  ActivitySpec,
  SceneState,
  LearnerAction,
  SceneCommand,
  ActionPayload,
  CommandResult,
} from "../shared";
export { applySceneCommand, commandFromAction } from "../session/sceneReducer";
