import mathCanvasSchema from './mathCanvas.schema.json';
import type { BoardKindDef, JsonSchema } from '../types';

// Placeholder board kinds (spec "Board item kinds"). Math is LaTeX, rendered with KaTeX.
export const boardKinds: BoardKindDef[] = [
  {
    name: 'math_canvas',
    description: 'An animated, persistent math canvas. Prefer this for explanations. Content: {title, moments:[{sentenceOffset,narration,visual,interactive:false,showEquation:false}]}. '
      + 'Include narration on EVERY moment: the app speaks these words automatically, exactly once, with the matching visual. Do not repeat them outside this tool. Offsets must be contiguous 0,1,2. Start each item with a complete visual. '
      + 'Visual shapes: {kind:"array",rows:4,columns:8,splitAt:null}; {kind:"bars",bars:[{id:"a",label:"One whole",parts:4,shaded:3}]}; '
      + '{kind:"geometry",shape:"rectangle",width:3,height:2}; {kind:"number_line",min:0,max:10,markers:[{id:"a",label:"A",value:3}]}. '
      + '{kind:"parallelogram",base:6,height:4,shear:2,stage:"slant"} shows a movable area proof. The top leans RIGHT. Cut detaches the LEFT triangle along the vertical height line; reassembled slides that LEFT triangle RIGHT by exactly the base length. Never describe the opposite direction. Later stages use {kind:"update",changes:[{type:"set_parallelogram",stage:"cut"}]} then {kind:"update",changes:[{type:"set_parallelogram",stage:"reassembled"}]}; all pieces keep their size. '
      + 'Later moments change the SAME picture with {kind:"update",changes:[{type:"set_array",splitAt:5}]} or set_geometry(width,height), set_bar(barId,parts,shaded), move_marker(markerId,value), set_focus(target), set_parallelogram(shear,stage). '
      + 'Use 1-4 moments, only final moment interactive. Array rows <=12, columns <=20; bars parts <=12; geometry dimensions 1-12 in halves. '
      + 'Example: {"title":"One rectangle, two parts","moments":[{"sentenceOffset":0,"narration":"Each of these four rows has eight squares.","visual":{"kind":"array","rows":4,"columns":8}},{"sentenceOffset":1,"narration":"Split each row into five and three; did the total change?","visual":{"kind":"update","changes":[{"type":"set_array","splitAt":5}]},"interactive":true}]}. '
      + 'Do not reveal equations before asking for a prediction. Use gap_task separately for assessed answers.',
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
