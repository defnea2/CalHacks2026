import { ActivitySpecSchema, type ActivitySpec } from './contracts';

export const fixtureCatalog = {
  groups: {
    id: 'equal-groups', kind: 'objects_groups', title: 'A little can become a lot',
    learningGoal: 'Explore multiplication as equal groups.', prompt: 'Can you put two seeds in each garden?',
    allowedInteractions: ['select', 'place', 'unplace'],
    objects: Array.from({ length: 6 }, (_, i) => ({ id: `seed-${i + 1}`, label: `Seed ${i + 1}`, icon: 'leaf' })),
    groups: [{ id: 'garden-a', label: 'Garden A' }, { id: 'garden-b', label: 'Garden B' }, { id: 'garden-c', label: 'Garden C' }],
  },
  bars: {
    id: 'equal-wholes', kind: 'bars_number_line', mode: 'bars', title: 'Same whole, different pieces',
    learningGoal: 'Compare unit fractions of equal-sized wholes.', prompt: 'Which coloured piece is larger? Try changing the number of parts.',
    allowedInteractions: ['select', 'set_parts', 'set_shaded'], min: 0, max: 1, markers: [],
    bars: [{ id: 'bar-a', label: 'Bar A', parts: 3, shaded: 1 }, { id: 'bar-b', label: 'Bar B', parts: 6, shaded: 1 }],
  },
  line: {
    id: 'number-distance', kind: 'bars_number_line', mode: 'number_line', title: 'Find your place',
    learningGoal: 'Connect numbers with positions on a number line.', prompt: 'Move the explorer to seven.',
    allowedInteractions: ['select', 'move_marker'], min: 0, max: 10, bars: [],
    markers: [{ id: 'explorer', label: 'Explorer', value: 2 }],
  },
  water: {
    id: 'water-journey', kind: 'diagram_sequence', title: 'A drop’s round trip',
    learningGoal: 'Explore a simplified water cycle.', prompt: 'Starting at the sea, what happens next? Arrange the stages, then connect them.',
    allowedInteractions: ['select', 'reorder', 'connect', 'disconnect'],
    nodes: [
      { id: 'sea', label: 'Water in the sea', icon: 'drop' },
      { id: 'rain', label: 'Rain falls', icon: 'cloud' },
      { id: 'vapor', label: 'Water evaporates', icon: 'sun' },
      { id: 'clouds', label: 'Vapour condenses into cloud droplets', icon: 'cloud' },
    ], edges: [],
  },
  shapes: {
    id: 'shape-reflections', kind: 'shape_workspace', title: 'Turn it. Flip it. Notice.',
    learningGoal: 'Explore rotations and reflections of shapes.', prompt: 'What changes when you flip the triangle? What stays the same?',
    allowedInteractions: ['select', 'transform', 'move'],
    shapes: [
      { id: 'triangle', label: 'Triangle', shape: 'triangle', x: 25, y: 50, size: 24, rotation: 0, reflected: false },
      { id: 'rectangle', label: 'Rectangle', shape: 'rectangle', x: 72, y: 50, size: 28, rotation: 0, reflected: false },
    ],
  },
  sorting: {
    id: 'sort-materials', kind: 'sorting_board', title: 'What is it made of?',
    learningGoal: 'Classify familiar objects by a stated material.', prompt: 'Sort each object by the material in its name.',
    allowedInteractions: ['select', 'place', 'unplace', 'reorder'],
    items: [
      { id: 'wood-spoon', label: 'Wooden spoon', icon: 'dot' }, { id: 'metal-spoon', label: 'Metal spoon', icon: 'dot' },
      { id: 'wood-block', label: 'Wooden block', icon: 'dot' }, { id: 'metal-key', label: 'Metal key', icon: 'dot' },
    ], categories: [{ id: 'wood', label: 'Wood' }, { id: 'metal', label: 'Metal' }],
  },
} satisfies Record<string, ActivitySpec>;

export type FixtureKey = keyof typeof fixtureCatalog;
export const fixtureKeys = Object.keys(fixtureCatalog) as FixtureKey[];
export function getFixture(key: FixtureKey): ActivitySpec {
  return ActivitySpecSchema.parse(fixtureCatalog[key]);
}
