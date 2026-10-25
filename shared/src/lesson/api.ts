// Pack-derived helpers. All phase/kind/taxonomy knowledge flows from a LessonPack value,
// so the module, worker and client never name a phase id or board kind themselves.
import type { JsonSchema, LessonPack, PhaseDef, BoardKindDef } from './types';
import type { ToolSpec } from '../types';
import { MEMORY_KINDS, MEMORY_OUTCOMES } from '../types';

export function getPhase(pack: LessonPack, id: string): PhaseDef | undefined {
  return pack.phases.find(p => p.id === id);
}

export function canTransition(pack: LessonPack, from: string, to: string): boolean {
  if (from === to) return true;
  return getPhase(pack, from)?.next.includes(to) ?? false;
}

export function getBoardKind(pack: LessonPack, name: string): BoardKindDef | undefined {
  return pack.boardKinds.find(k => k.name === name);
}

export function isCategory(pack: LessonPack, category: string): boolean {
  return pack.taxonomy.some(c => c.key === category);
}

export function conceptBelongsTo(pack: LessonPack, category: string, concept: string): boolean {
  return pack.taxonomy.find(c => c.key === category)?.concepts.some(k => k.key === concept) ?? false;
}

/** Validates `value` against the JsonSchema subset. Returns error messages ([] = valid). */
export function validateJson(schema: JsonSchema, value: unknown, path = '$'): string[] {
  const errs: string[] = [];
  if (schema.oneOf || schema.anyOf) {
    const ok = (schema.oneOf ?? schema.anyOf!).some(s => validateJson(s, value, path).length === 0);
    return ok ? [] : [`${path}: matches none of the allowed shapes`];
  }
  if ('const' in schema && value !== schema.const) errs.push(`${path}: wrong literal value`);
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    errs.push(`${path}: must be one of ${schema.enum.join(', ')}`);
  }
  switch (schema.type) {
    case 'null':
      if (value !== null) errs.push(`${path}: must be null`);
      break;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path}: must be an object`];
      const obj = value as Record<string, unknown>;
      for (const r of schema.required ?? []) if (obj[r] === undefined) errs.push(`${path}.${r}: is required`);
      for (const [k, v] of Object.entries(obj)) {
        const sub = schema.properties?.[k];
        if (sub) errs.push(...validateJson(sub, v, `${path}.${k}`));
        else if (schema.additionalProperties === false) errs.push(`${path}.${k}: is not allowed`);
      }
      break;
    }
    case 'array':
      if (!Array.isArray(value)) return [`${path}: must be an array`];
      if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: needs at least ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: at most ${schema.maxItems} items`);
      if (schema.items) value.forEach((v, i) => errs.push(...validateJson(schema.items!, v, `${path}[${i}]`)));
      break;
    case 'string':
      if (typeof value !== 'string') return [`${path}: must be a string`];
      if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path}: too short`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path}: at most ${schema.maxLength} characters`);
      break;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path}: must be a number`];
      if (schema.multipleOf && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-8) errs.push(`${path}: invalid increment`);
      if (schema.type === 'integer' && !Number.isInteger(value)) errs.push(`${path}: must be a whole number`);
      if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: must be <= ${schema.maximum}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return [`${path}: must be true or false`];
      break;
  }
  return errs;
}

/** Replaces {{name}} placeholders. Unknown placeholders are left as-is (contract tests catch them). */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in values ? values[k]! : m));
}

export function templatePlaceholders(template: string): string[] {
  return [...template.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]!);
}

// ---------------------------------------------------------------------------
// Tool definitions, generated from the pack. The worker registry attaches handlers;
// the module validates the same arguments again.
// ---------------------------------------------------------------------------

export const TOOL_NAMES = {
  setTopic: 'set_topic',
  setPhase: 'set_phase',
  showBoardItem: 'show_board_item',
  clearBoard: 'clear_board',
  remember: 'remember',
} as const;

export function buildToolSpecs(pack: LessonPack): ToolSpec[] {
  const categories = pack.taxonomy.map(c => c.key);
  const concepts = pack.taxonomy.flatMap(c => c.concepts.map(k => k.key));
  return [
    {
      name: TOOL_NAMES.setTopic,
      description:
        'Set the session topic once you know it. Returns library material (concepts, skills, explanations, tasks) and what we know about this learner for the category.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: categories },
          concept: { type: 'string', enum: concepts, description: 'Optional finer concept within the category.' },
        },
        required: ['category'],
      },
    },
    {
      name: TOOL_NAMES.setPhase,
      description: 'Move the lesson to another phase. Only allowed transitions succeed.',
      parameters: {
        type: 'object',
        properties: {
          phase: { type: 'string', enum: pack.phases.map(p => p.id) },
          reason: { type: 'string', description: 'One short sentence why.' },
        },
        required: ['phase', 'reason'],
      },
    },
    {
      name: TOOL_NAMES.showBoardItem,
      description:
        'Show something on the shared board. Either pass kind + content, or a library taskKey. ' +
        pack.boardKinds.map(k => `${k.name}: ${k.description}`).join(' | '),
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: pack.boardKinds.map(k => k.name) },
          content: { type: 'object', description: 'Content object for the kind (see kind descriptions).' },
          taskKey: { type: 'string', description: 'Key of a library task to show instead of content.' },
          expectedAnswer: {
            type: 'object',
            properties: { form: { type: 'string', enum: ['number', 'fraction', 'choice', 'text'] }, value: { type: 'string' } },
            required: ['form', 'value'],
            description: 'Required for gap tasks you write yourself.',
          },
        },
      },
    },
    {
      name: TOOL_NAMES.clearBoard,
      description: 'Hide all current board items.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: TOOL_NAMES.remember,
      description: 'Save an internal note about the learner right away (e.g. a strategy that worked). Never mention notes to the student.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...MEMORY_KINDS] },
          category: { type: 'string', enum: categories },
          concept: { type: 'string', enum: concepts },
          text: { type: 'string' },
          outcome: { type: 'string', enum: [...MEMORY_OUTCOMES] },
        },
        required: ['kind', 'category', 'text', 'outcome'],
      },
    },
  ];
}

/** {{phases}} block for the system prompt. */
export function describePhases(pack: LessonPack): string {
  return pack.phases
    .map(p => `- ${p.id} (${p.label}): ${p.description} Next: ${p.next.length ? p.next.join(', ') : 'none (last)'}.`)
    .join('\n');
}

/** {{concepts}} block for the system prompt. */
export function describeTaxonomy(pack: LessonPack): string {
  return pack.taxonomy.map(c => `- ${c.key}: ${c.concepts.map(k => k.key).join(', ')}`).join('\n');
}

/** {{board}} kinds block for the system prompt. */
export function describeBoardKinds(pack: LessonPack): string {
  return pack.boardKinds.map(k => `- ${k.name}: ${k.description}`).join('\n');
}
