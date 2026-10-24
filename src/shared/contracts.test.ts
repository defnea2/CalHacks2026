import { describe, expect, it } from 'vitest';
import { ActivitySpecSchema, createScene, SceneStateSchema } from './contracts';
import { fixtureKeys, getFixture } from './fixtures';

describe('activity and scene boundaries', () => {
  it.each(fixtureKeys)('accepts the %s fixture and its initial scene', key => {
    expect(() => createScene(getFixture(key))).not.toThrow();
  });
  it('rejects duplicate IDs across objects and containers', () => {
    const activity = getFixture('groups');
    if (activity.kind !== 'objects_groups') throw new Error('Fixture mismatch');
    activity.groups[0].id = activity.objects[0].id;
    expect(ActivitySpecSchema.safeParse(activity).success).toBe(false);
  });
  it('rejects impossible fractions and out-of-range number line markers', () => {
    const activity = getFixture('bars');
    if (activity.kind !== 'bars_number_line') throw new Error('Fixture mismatch');
    activity.bars[0].shaded = 12;
    expect(ActivitySpecSchema.safeParse(activity).success).toBe(false);
    const line = getFixture('line');
    if (line.kind !== 'bars_number_line') throw new Error('Fixture mismatch');
    line.markers[0].value = 11;
    expect(ActivitySpecSchema.safeParse(line).success).toBe(false);
  });
  it('rejects dangling connections', () => {
    const activity = getFixture('water');
    if (activity.kind !== 'diagram_sequence') throw new Error('Fixture mismatch');
    activity.edges.push({ id: 'bad-edge', from: 'sea', to: 'missing', label: '' });
    expect(ActivitySpecSchema.safeParse(activity).success).toBe(false);
  });
  it('rejects unsupported behavior and executable properties', () => {
    expect(ActivitySpecSchema.safeParse({ ...getFixture('groups'), allowedInteractions: ['transform'] }).success).toBe(false);
    expect(ActivitySpecSchema.safeParse({ ...getFixture('groups'), script: 'alert(1)' }).success).toBe(false);
  });
  it('rejects orphaned placements and repeated order entries', () => {
    const scene = createScene(getFixture('groups'));
    expect(SceneStateSchema.safeParse({ ...scene, placements: { 'seed-1': 'missing' } }).success).toBe(false);
    expect(SceneStateSchema.safeParse({ ...scene, order: Array(6).fill('seed-1') }).success).toBe(false);
  });
});
