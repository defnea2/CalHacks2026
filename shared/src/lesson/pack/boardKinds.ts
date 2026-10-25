import type { BoardKindDef } from '../types';

// Placeholder board kinds (spec "Board item kinds"). Math is LaTeX, rendered with KaTeX.
export const boardKinds: BoardKindDef[] = [
  {
    name: 'text',
    description: 'A short sentence on the board.',
    contentSchema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 200 } },
      required: ['text'],
    },
  },
  {
    name: 'equation',
    description: 'One line of math in LaTeX, e.g. \\frac{2}{3} = \\frac{8}{12}.',
    contentSchema: {
      type: 'object',
      properties: { latex: { type: 'string', maxLength: 300 }, caption: { type: 'string', maxLength: 120 } },
      required: ['latex'],
    },
  },
  {
    name: 'worked_steps',
    description: 'Numbered steps revealed one by one. Each step has LaTeX `show` and an optional short `note`.',
    contentSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 120 },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            properties: { show: { type: 'string', maxLength: 300 }, note: { type: 'string', maxLength: 160 } },
            required: ['show'],
          },
        },
        /** Number of steps revealed so far; omit to reveal all. */
        revealed: { type: 'integer', minimum: 0, maximum: 8 },
      },
      required: ['steps'],
    },
  },
  {
    name: 'gap_task',
    description: 'An exercise with one blank (written \\square in the LaTeX) that the student fills by voice or tap. Always pass expectedAnswer.',
    contentSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', maxLength: 200 },
        latex: { type: 'string', maxLength: 300 },
        /** Optional tap choices. */
        choices: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 40 } },
      },
      required: ['latex'],
    },
  },
  {
    name: 'visual',
    description:
      'A picture: number_line {min,max,marks[],highlight?}, fraction_bar {parts,shaded,label?}, area_grid {rows,cols,shaded}, groups {groups,perGroup,item?}.',
    contentSchema: {
      type: 'object',
      properties: {
        visual: { type: 'string', enum: ['number_line', 'fraction_bar', 'area_grid', 'groups'] },
        caption: { type: 'string', maxLength: 120 },
        min: { type: 'number' },
        max: { type: 'number' },
        marks: { type: 'array', maxItems: 40, items: { type: 'number' } },
        highlight: { type: 'number' },
        parts: { type: 'integer', minimum: 1, maximum: 48 },
        shaded: { type: 'integer', minimum: 0, maximum: 400 },
        label: { type: 'string', maxLength: 40 },
        rows: { type: 'integer', minimum: 1, maximum: 20 },
        cols: { type: 'integer', minimum: 1, maximum: 20 },
        groups: { type: 'integer', minimum: 1, maximum: 12 },
        perGroup: { type: 'integer', minimum: 1, maximum: 20 },
        item: { type: 'string', maxLength: 8 },
      },
      required: ['visual'],
    },
  },
];
