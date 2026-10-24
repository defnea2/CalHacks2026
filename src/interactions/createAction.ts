import { CONTRACT_VERSION, LearnerActionSchema, type ActionPayload, type LearnerAction, type SceneState } from '../shared';

export function createAction(scene: SceneState, payload: ActionPayload, source: LearnerAction['source'] = 'pointer'): LearnerAction {
  return LearnerActionSchema.parse({ contractVersion: CONTRACT_VERSION, eventId: crypto.randomUUID(), sceneId: scene.sceneId, sceneRevision: scene.revision, source, payload });
}
