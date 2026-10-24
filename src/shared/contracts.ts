import { z } from 'zod';

export const CONTRACT_VERSION = '1.0.0' as const;
export const IdSchema = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
const label = z.string().min(1).max(160);
const shortText = z.string().min(1).max(1200);
const coordinate = z.number().finite().min(0).max(100);
const item = z.object({ id: IdSchema, label, icon: z.enum(['dot', 'leaf', 'sun', 'cloud', 'drop', 'animal', 'book']).default('dot') }).strict();
const container = z.object({ id: IdSchema, label }).strict();

export const InteractionSchema = z.enum(['select', 'place', 'unplace', 'reorder', 'set_parts', 'set_shaded', 'move_marker', 'transform', 'move', 'connect', 'disconnect']);
const common = {
  id: IdSchema,
  title: label,
  prompt: shortText,
  learningGoal: shortText,
  allowedInteractions: z.array(InteractionSchema).max(11),
};

// These are configuration schemas, not executable model-generated UI.
const activityUnion = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('objects_groups'), objects: z.array(item).min(1).max(40), groups: z.array(container).min(1).max(8) }).strict(),
  z.object({
    ...common, kind: z.literal('bars_number_line'), mode: z.enum(['bars', 'number_line']),
    bars: z.array(z.object({ id: IdSchema, label, parts: z.number().int().min(1).max(12), shaded: z.number().int().min(0).max(12) }).strict()).max(4),
    min: z.number().finite().min(-1000).max(1000), max: z.number().finite().min(-1000).max(1000),
    markers: z.array(z.object({ id: IdSchema, label, value: z.number().finite() }).strict()).max(6),
  }).strict(),
  z.object({
    ...common, kind: z.literal('diagram_sequence'),
    nodes: z.array(item).min(2).max(12),
    edges: z.array(z.object({ id: IdSchema, from: IdSchema, to: IdSchema, label: z.string().max(80) }).strict()).max(24),
  }).strict(),
  z.object({
    ...common, kind: z.literal('shape_workspace'),
    shapes: z.array(z.object({
      id: IdSchema, label, shape: z.enum(['circle', 'rectangle', 'triangle']),
      x: coordinate, y: coordinate, size: z.number().min(5).max(40),
      rotation: z.number().finite().min(-360).max(360), reflected: z.boolean(),
    }).strict()).min(1).max(12),
  }).strict(),
  z.object({ ...common, kind: z.literal('sorting_board'), items: z.array(item).min(1).max(24), categories: z.array(container).min(2).max(6) }).strict(),
]);

export type ActivitySpec = z.infer<typeof activityUnion>;

export function objectIds(activity: ActivitySpec): string[] {
  switch (activity.kind) {
    case 'objects_groups': return activity.objects.map(x => x.id);
    case 'sorting_board': return activity.items.map(x => x.id);
    case 'diagram_sequence': return activity.nodes.map(x => x.id);
    case 'shape_workspace': return activity.shapes.map(x => x.id);
    case 'bars_number_line': return [...activity.bars, ...activity.markers].map(x => x.id);
  }
}

export function containerIds(activity: ActivitySpec): string[] {
  if (activity.kind === 'objects_groups') return activity.groups.map(x => x.id);
  if (activity.kind === 'sorting_board') return activity.categories.map(x => x.id);
  return [];
}

export const ActivitySpecSchema = activityUnion.superRefine((activity, ctx) => {
  const ids = [...objectIds(activity), ...containerIds(activity)];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Object and container IDs must be unique.' });
  const supported: Record<ActivitySpec['kind'], string[]> = {
    objects_groups: ['select', 'place', 'unplace'], sorting_board: ['select', 'place', 'unplace', 'reorder'],
    diagram_sequence: ['select', 'reorder', 'connect', 'disconnect'], shape_workspace: ['select', 'transform', 'move'],
    bars_number_line: ['select', 'set_parts', 'set_shaded', 'move_marker'],
  };
  if (activity.allowedInteractions.some(action => !supported[activity.kind].includes(action))) {
    ctx.addIssue({ code: 'custom', message: 'Interaction is incompatible with this activity kind.' });
  }
  if (activity.kind === 'bars_number_line') {
    if (activity.min >= activity.max) ctx.addIssue({ code: 'custom', message: 'Number line min must be less than max.' });
    if (activity.bars.some(bar => bar.shaded > bar.parts)) ctx.addIssue({ code: 'custom', message: 'Shading exceeds partition count.' });
    if (activity.markers.some(marker => marker.value < activity.min || marker.value > activity.max)) ctx.addIssue({ code: 'custom', message: 'Marker outside number line range.' });
    if (activity.mode === 'bars' && !activity.bars.length) ctx.addIssue({ code: 'custom', message: 'Bars mode needs a bar.' });
    if (activity.mode === 'number_line' && !activity.markers.length) ctx.addIssue({ code: 'custom', message: 'Number line mode needs a marker.' });
  }
  if (activity.kind === 'diagram_sequence') {
    if (new Set(activity.edges.map(x => x.id)).size !== activity.edges.length) ctx.addIssue({ code: 'custom', message: 'Edge IDs must be unique.' });
    if (activity.edges.some(edge => !ids.includes(edge.from) || !ids.includes(edge.to) || edge.from === edge.to)) ctx.addIssue({ code: 'custom', message: 'Edges must join two existing, distinct nodes.' });
  }
});

export const SceneStateSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  sceneId: IdSchema,
  revision: z.number().int().nonnegative(),
  activity: ActivitySpecSchema,
  selectedIds: z.array(IdSchema).max(40),
  highlightedIds: z.array(IdSchema).max(40),
  placements: z.record(IdSchema, IdSchema),
  order: z.array(IdSchema).max(40),
  appliedCommandIds: z.array(IdSchema).max(10000),
}).strict().superRefine((scene, ctx) => {
  const objects = objectIds(scene.activity);
  const containers = containerIds(scene.activity);
  if ([...scene.selectedIds, ...scene.highlightedIds, ...scene.order].some(id => !objects.includes(id))) ctx.addIssue({ code: 'custom', message: 'Scene references an unknown object.' });
  if (scene.order.length !== objects.length || new Set(scene.order).size !== objects.length) ctx.addIssue({ code: 'custom', message: 'Order must contain every object exactly once.' });
  if (Object.entries(scene.placements).some(([id, target]) => !objects.includes(id) || !containers.includes(target))) ctx.addIssue({ code: 'custom', message: 'Invalid placement references.' });
});
export type SceneState = z.infer<typeof SceneStateSchema>;

const actionPayload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('select'), objectId: IdSchema }).strict(),
  z.object({ type: z.literal('place'), objectId: IdSchema, containerId: IdSchema }).strict(),
  z.object({ type: z.literal('unplace'), objectId: IdSchema }).strict(),
  z.object({ type: z.literal('reorder'), objectIds: z.array(IdSchema).min(1).max(40) }).strict(),
  z.object({ type: z.literal('set_parts'), objectId: IdSchema, parts: z.number().int().min(1).max(12) }).strict(),
  z.object({ type: z.literal('set_shaded'), objectId: IdSchema, shaded: z.number().int().min(0).max(12) }).strict(),
  z.object({ type: z.literal('move_marker'), objectId: IdSchema, value: z.number().finite() }).strict(),
  z.object({ type: z.literal('transform'), objectId: IdSchema, rotation: z.number().finite().min(-360).max(360), reflected: z.boolean() }).strict(),
  z.object({ type: z.literal('move'), objectId: IdSchema, x: coordinate, y: coordinate }).strict(),
  z.object({ type: z.literal('connect'), from: IdSchema, to: IdSchema }).strict(),
  z.object({ type: z.literal('disconnect'), edgeId: IdSchema }).strict(),
]);
export type ActionPayload = z.infer<typeof actionPayload>;

export const LearnerActionSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  eventId: IdSchema,
  sceneId: IdSchema,
  sceneRevision: z.number().int().nonnegative(),
  source: z.enum(['pointer', 'keyboard', 'voice']),
  payload: actionPayload,
}).strict();
export type LearnerAction = z.infer<typeof LearnerActionSchema>;

export const SceneCommandSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  commandId: IdSchema,
  sceneId: IdSchema,
  expectedRevision: z.number().int().nonnegative(),
  payload: z.union([
    actionPayload,
    z.object({ type: z.literal('replace_activity'), activity: ActivitySpecSchema }).strict(),
    z.object({ type: z.literal('update_activity'), activity: ActivitySpecSchema }).strict(),
    z.object({ type: z.literal('highlight'), objectIds: z.array(IdSchema).max(40) }).strict(),
    z.object({ type: z.literal('clear_highlights') }).strict(),
  ]),
}).strict();
export type SceneCommand = z.infer<typeof SceneCommandSchema>;
export type CommandResult =
  | { ok: true; commandId: string; status: 'applied' | 'already_applied'; scene: SceneState }
  | { ok: false; commandId: string; error: 'invalid_command' | 'wrong_scene' | 'stale_revision' | 'invalid_action'; message: string; scene: SceneState };

export function createScene(activity: ActivitySpec, sceneId = 'scene-main'): SceneState {
  return SceneStateSchema.parse({ contractVersion: CONTRACT_VERSION, sceneId, revision: 0, activity,
    selectedIds: [], highlightedIds: [], placements: {}, order: objectIds(activity), appliedCommandIds: [] });
}
