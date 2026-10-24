import { containerIds, createScene, objectIds, SceneCommandSchema, SceneStateSchema, type CommandResult, type LearnerAction, type SceneCommand, type SceneState } from '../shared';

/** Sole mutation boundary. Transport and components must never mutate a scene directly. */
export function applySceneCommand(scene: SceneState, input: unknown): CommandResult {
  const parsed = SceneCommandSchema.safeParse(input);
  const fail = (error: Extract<CommandResult, { ok: false }>['error'], message: string): CommandResult => ({
    ok: false, commandId: parsed.success ? parsed.data.commandId : 'invalid', error, message, scene,
  });
  if (!parsed.success) return fail('invalid_command', parsed.error.issues.map(x => x.message).join('; '));
  const command = parsed.data;
  if (command.sceneId !== scene.sceneId) return fail('wrong_scene', 'This command belongs to another scene. Read the current context.');
  if (scene.appliedCommandIds.includes(command.commandId)) return { ok: true, commandId: command.commandId, status: 'already_applied', scene };
  if (command.expectedRevision !== scene.revision) return fail('stale_revision', 'The scene changed. Read it again and replan; do not blindly retry.');
  let next = SceneStateSchema.parse(scene);
  const payload = command.payload;
  const ids = objectIds(scene.activity);
  const allowed = scene.activity.allowedInteractions as string[];
  if (!['replace_activity', 'update_activity', 'highlight', 'clear_highlights'].includes(payload.type) && !allowed.includes(payload.type)) {
    return fail('invalid_action', 'This interaction is disabled for the current activity.');
  }
  switch (payload.type) {
    case 'replace_activity': next = createScene(payload.activity, scene.sceneId); break;
    case 'update_activity': {
      if (payload.activity.id !== scene.activity.id || payload.activity.kind !== scene.activity.kind) return fail('invalid_action', 'Use replace_activity to change activity identity or kind.');
      const remaining = objectIds(payload.activity), targets = containerIds(payload.activity);
      next.activity = payload.activity;
      next.selectedIds = next.selectedIds.filter(id => remaining.includes(id));
      next.highlightedIds = next.highlightedIds.filter(id => remaining.includes(id));
      next.placements = Object.fromEntries(Object.entries(next.placements).filter(([id, target]) => remaining.includes(id) && targets.includes(target)));
      next.order = [...next.order.filter(id => remaining.includes(id)), ...remaining.filter(id => !next.order.includes(id))];
      break;
    }
    case 'highlight': next.highlightedIds = payload.objectIds; break;
    case 'clear_highlights': next.highlightedIds = []; break;
    case 'select':
      if (!ids.includes(payload.objectId)) return fail('invalid_action', 'Unknown object.');
      next.selectedIds = next.selectedIds.includes(payload.objectId) ? [] : [payload.objectId];
      break;
    case 'place': next.placements[payload.objectId] = payload.containerId; break;
    case 'unplace':
      if (!ids.includes(payload.objectId)) return fail('invalid_action', 'Unknown object.');
      delete next.placements[payload.objectId]; break;
    case 'reorder': next.order = payload.objectIds; break;
    case 'set_parts': {
      if (next.activity.kind !== 'bars_number_line' || next.activity.mode !== 'bars') return fail('invalid_action', 'This scene has no editable bars.');
      const bar = next.activity.bars.find(x => x.id === payload.objectId);
      if (!bar) return fail('invalid_action', 'Unknown bar.');
      if (bar.shaded > payload.parts) return fail('invalid_action', 'Partition count cannot be less than the shaded count.');
      bar.parts = payload.parts;
      break;
    }
    case 'set_shaded': {
      if (next.activity.kind !== 'bars_number_line' || next.activity.mode !== 'bars') return fail('invalid_action', 'This scene has no editable bars.');
      const bar = next.activity.bars.find(x => x.id === payload.objectId);
      if (!bar || payload.shaded > bar.parts) return fail('invalid_action', 'Shading must be within the existing bar.');
      bar.shaded = payload.shaded;
      break;
    }
    case 'move_marker': {
      if (next.activity.kind !== 'bars_number_line' || next.activity.mode !== 'number_line') return fail('invalid_action', 'This scene has no editable number line.');
      const marker = next.activity.markers.find(x => x.id === payload.objectId);
      if (!marker) return fail('invalid_action', 'Unknown marker.');
      marker.value = payload.value;
      break;
    }
    case 'transform': {
      if (next.activity.kind !== 'shape_workspace') return fail('invalid_action', 'This scene has no shapes.');
      const shape = next.activity.shapes.find(x => x.id === payload.objectId);
      if (!shape) return fail('invalid_action', 'Unknown shape.');
      shape.rotation = payload.rotation; shape.reflected = payload.reflected;
      break;
    }
    case 'move': {
      if (next.activity.kind !== 'shape_workspace') return fail('invalid_action', 'This scene has no movable shapes.');
      const shape = next.activity.shapes.find(x => x.id === payload.objectId);
      if (!shape) return fail('invalid_action', 'Unknown shape.');
      shape.x = payload.x; shape.y = payload.y;
      break;
    }
    case 'connect': {
      if (next.activity.kind !== 'diagram_sequence') return fail('invalid_action', 'This scene has no diagram.');
      if (next.activity.edges.some(x => x.from === payload.from && x.to === payload.to)) return fail('invalid_action', 'These nodes are already connected.');
      next.activity.edges.push({ id: command.commandId, from: payload.from, to: payload.to, label: '' });
      break;
    }
    case 'disconnect': {
      if (next.activity.kind !== 'diagram_sequence') return fail('invalid_action', 'This scene has no diagram.');
      if (!next.activity.edges.some(edge => edge.id === payload.edgeId)) return fail('invalid_action', 'Unknown connection.');
      next.activity.edges = next.activity.edges.filter(edge => edge.id !== payload.edgeId);
      break;
    }
  }
  next.revision = scene.revision + 1;
  next.appliedCommandIds = [...scene.appliedCommandIds, command.commandId];
  const checked = SceneStateSchema.safeParse(next);
  if (!checked.success) return fail('invalid_action', checked.error.issues.map(x => x.message).join('; '));
  return { ok: true, commandId: command.commandId, status: 'applied', scene: checked.data };
}

export function commandFromAction(action: LearnerAction): SceneCommand {
  return {
    contractVersion: action.contractVersion, commandId: action.eventId, sceneId: action.sceneId,
    expectedRevision: action.sceneRevision, payload: action.payload,
  };
}
