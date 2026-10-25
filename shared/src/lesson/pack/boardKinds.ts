import mathCanvasSchema from './mathCanvas.schema.json';
import type { BoardKindDef, JsonSchema } from '../types';

// Placeholder board kinds (spec "Board item kinds"). Math is LaTeX, rendered with KaTeX.
export const boardKinds: BoardKindDef[] = [
  {
    name: 'math_canvas',
    description: 'A verified animated math explanation. Content: {title,moments:[{sentenceOffset,teaching:{concept,action,targets:[]},visual,interactive:false,showEquation:false}]}. '
      + 'Do NOT author narration: the app derives speech from the actual diagram and speaks it exactly once. Offsets 0,1,2,3; start with a complete visual; later use updates. Only final moment interactive. '
      + 'Concepts: equal_groups/distributivity require array; fraction_amount/fraction_comparison/fraction_equivalence require bars; number_order/number_distance require number_line; area/area_conservation require geometry or parallelogram. Unsupported concepts must use visual_unavailable. '
      + 'Actions: observe describes structure, calculate derives the result, compare computes a relation between two visible targets, change describes a real transformation, conserve proves a changed picture preserved the quantity, question asks about the current picture. Question must be final, with showEquation:false. '
      + 'Visuals: {kind:"array",rows:3,columns:7,splitAt:null}; {kind:"bars",bars:[{id:"a",label:"A",parts:4,shaded:3},{id:"b",label:"B",parts:3,shaded:2}]}; {kind:"geometry",shape:"rectangle",width:3,height:2}; {kind:"number_line",min:0,max:10,markers:[{id:"a",label:"A",value:3},{id:"b",label:"B",value:7}]}; {kind:"parallelogram",base:6,height:4,shear:2,stage:"slant"}. Labels are assigned A,B by code. '
      + 'Update example: {kind:"update",changes:[{type:"set_array",splitAt:5}]}; also set_geometry(width,height), set_bar(barId,parts,shaded), move_marker(markerId,value), set_parallelogram(shear,stage). Parallelogram stages slant,cut,reassembled. A keep command is allowed for a final calculation or question, never a claimed transformation. '
      + 'Choose quantities and transformations for this learner. Do not pad with repeated observations. New generated demonstrations must use this kind; other kinds are for existing library taskKey only.',
    contentSchema: mathCanvasSchema as unknown as JsonSchema,
  },
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
      'A picture. content.visual names it: "number_line" {min,max,marks[],highlight?}, "fraction_bar" {parts,shaded,label?}, ' +
      '"area_grid" {rows,cols,shaded}, "groups" {groups,perGroup,item?}. Example content: {"visual":"fraction_bar","parts":3,"shaded":2,"label":"two thirds"}.',
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
