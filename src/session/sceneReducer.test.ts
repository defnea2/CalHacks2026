import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, createScene, type SceneCommand, type SceneState } from '../shared';
import { getFixture } from '../shared/fixtures';
import { applySceneCommand } from './sceneReducer';

function command(scene: SceneState, payload: SceneCommand['payload'], id = 'command-1'): SceneCommand {
  return { contractVersion: CONTRACT_VERSION, commandId: id, sceneId: scene.sceneId, expectedRevision: scene.revision, payload };
}
describe('authoritative scene updates', () => {
  it('applies a learner placement without mutating its input', () => {
    const scene = createScene(getFixture('groups'));
    const result = applySceneCommand(scene, command(scene, { type: 'place', objectId: 'seed-1', containerId: 'garden-a' }));
    expect(result.ok).toBe(true);
    expect(result.scene.placements['seed-1']).toBe('garden-a');
    expect(result.scene.revision).toBe(1);
    expect(scene.placements).toEqual({});
  });
  it('rejects stale commands after a local interaction', () => {
    const scene = createScene(getFixture('groups'));
    const result = applySceneCommand(scene, command(scene, { type: 'select', objectId: 'seed-1' }));
    const stale = applySceneCommand(result.scene, command(scene, { type: 'highlight', objectIds: ['seed-2'] }, 'old-tool'));
    expect(stale).toMatchObject({ ok: false, error: 'stale_revision' });
    expect(stale.scene.highlightedIds).toEqual([]);
  });
  it('deduplicates retried commands before checking their old revision', () => {
    const scene = createScene(getFixture('groups'));
    const request = command(scene, { type: 'select', objectId: 'seed-1' });
    const result = applySceneCommand(scene, request);
    const duplicate = applySceneCommand(result.scene, request);
    expect(duplicate).toMatchObject({ ok: true, status: 'already_applied' });
    expect(duplicate.scene.revision).toBe(1);
    expect(duplicate.scene.selectedIds).toEqual(['seed-1']);
  });
  it('rejects unknown targets transactionally', () => {
    const scene = createScene(getFixture('groups'));
    const result = applySceneCommand(scene, command(scene, { type: 'place', objectId: 'seed-1', containerId: 'missing' }));
    expect(result).toMatchObject({ ok: false, error: 'invalid_action' });
    expect(result.scene).toBe(scene);
  });
  it('rejects malformed, wrong-scene, and unsupported commands', () => {
    const scene = createScene(getFixture('groups'));
    expect(applySceneCommand(scene, { bad: true })).toMatchObject({ ok: false, error: 'invalid_command' });
    expect(applySceneCommand(scene, { ...command(scene, { type: 'select', objectId: 'seed-1' }), sceneId: 'other' })).toMatchObject({ ok: false, error: 'wrong_scene' });
    expect(applySceneCommand(scene, command(scene, { type: 'set_parts', objectId: 'seed-1', parts: 2 }))).toMatchObject({ ok: false, error: 'invalid_action' });
  });
  it('replaces an activity and clears obsolete object references while preserving revision history', () => {
    let scene = createScene(getFixture('groups'));
    scene = applySceneCommand(scene, command(scene, { type: 'select', objectId: 'seed-1' })).scene;
    const result = applySceneCommand(scene, command(scene, { type: 'replace_activity', activity: getFixture('water') }, 'replace'));
    expect(result.ok).toBe(true);
    expect(result.scene.selectedIds).toEqual([]);
    expect(result.scene.order).toEqual(['sea', 'rain', 'vapor', 'clouds']);
    expect(result.scene.revision).toBe(2);
    expect(result.scene.appliedCommandIds).toEqual(['command-1', 'replace']);
  });
  it('rejects duplicate/missing order members and out-of-range markers', () => {
    const scene = createScene(getFixture('water'));
    expect(applySceneCommand(scene, command(scene, { type: 'reorder', objectIds: ['sea', 'sea'] })).ok).toBe(false);
    const line = createScene(getFixture('line'));
    expect(applySceneCommand(line, command(line, { type: 'move_marker', objectId: 'explorer', value: 15 })).ok).toBe(false);
  });
  it('updates teaching content while retaining valid learner work and pruning removed objects', () => {
    let scene = createScene(getFixture('groups'));
    scene = applySceneCommand(scene, command(scene, { type: 'place', objectId: 'seed-2', containerId: 'garden-a' }, 'place')).scene;
    scene = applySceneCommand(scene, command(scene, { type: 'select', objectId: 'seed-1' }, 'select')).scene;
    const activity = getFixture('groups');
    if (activity.kind !== 'objects_groups') throw new Error('Fixture mismatch');
    activity.objects = activity.objects.filter(item => item.id !== 'seed-1');
    activity.objects.push({ id: 'new-seed', label: 'New seed', icon: 'leaf' });
    activity.prompt = 'Try another group.';
    const result = applySceneCommand(scene, command(scene, { type: 'update_activity', activity }, 'update'));
    expect(result.ok).toBe(true);
    expect(result.scene.placements).toEqual({ 'seed-2': 'garden-a' });
    expect(result.scene.selectedIds).toEqual([]);
    expect(result.scene.order).toEqual(['seed-2', 'seed-3', 'seed-4', 'seed-5', 'seed-6', 'new-seed']);
    expect(result.scene.activity.prompt).toBe('Try another group.');
    expect(applySceneCommand(result.scene, command(result.scene, { type: 'update_activity', activity: getFixture('water') }, 'wrong-update')).ok).toBe(false);
  });
  it('supports returning objects and removing edges without dangling state', () => {
    let scene = createScene(getFixture('groups'));
    scene = applySceneCommand(scene, command(scene, { type: 'place', objectId: 'seed-1', containerId: 'garden-a' }, 'place')).scene;
    const returned = applySceneCommand(scene, command(scene, { type: 'unplace', objectId: 'seed-1' }, 'return'));
    expect(returned.ok).toBe(true); expect(returned.scene.placements).toEqual({});
    let diagram = createScene(getFixture('water'));
    diagram = applySceneCommand(diagram, command(diagram, { type: 'connect', from: 'sea', to: 'vapor' }, 'edge')).scene;
    const disconnected = applySceneCommand(diagram, command(diagram, { type: 'disconnect', edgeId: 'edge' }, 'remove'));
    expect(disconnected.ok).toBe(true);
    if (disconnected.scene.activity.kind === 'diagram_sequence') expect(disconnected.scene.activity.edges).toEqual([]);
    expect(applySceneCommand(diagram, command(diagram, { type: 'disconnect', edgeId: 'missing' }, 'bad')).ok).toBe(false);
  });
  it('validates movable shape positions and shaded quantities', () => {
    const shapes = createScene(getFixture('shapes'));
    const moved = applySceneCommand(shapes, command(shapes, { type: 'move', objectId: 'triangle', x: 30, y: 75 }));
    expect(moved.ok).toBe(true);
    if (moved.scene.activity.kind === 'shape_workspace') expect(moved.scene.activity.shapes[0]).toMatchObject({ x: 30, y: 75 });
    expect(applySceneCommand(shapes, command(shapes, { type: 'move', objectId: 'triangle', x: 101, y: 0 })).ok).toBe(false);
    const bars = createScene(getFixture('bars'));
    expect(applySceneCommand(bars, command(bars, { type: 'set_shaded', objectId: 'bar-a', shaded: 3 })).ok).toBe(true);
    expect(applySceneCommand(bars, command(bars, { type: 'set_shaded', objectId: 'bar-a', shaded: 4 })).ok).toBe(false);
  });
});
