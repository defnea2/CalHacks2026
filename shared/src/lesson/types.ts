// The lesson pack contract. Everything that is placeholder content (phases, prompts,
// board kinds, taxonomy, seed library) is described by these types and exported from
// shared/src/lesson/index.ts. No other code may hard-code a phase id or board kind name.

/** Minimal JSON Schema subset understood by validateJson (shared/src/lesson/validate.ts). */
export type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
  minItems?: number;
  oneOf?: JsonSchema[];
  additionalProperties?: boolean;
};

export interface PhaseDef {
  id: string;
  label: string;
  /** Shown to the LLM in the system prompt ({{phases}}). */
  description: string;
  /** Detailed instructions for this phase: what the tutor does, what to watch for, when to
   *  move on. Only the CURRENT phase's block is in the system prompt ({{phaseInstructions}});
   *  it is swapped completely when the phase changes. */
  instructions: string;
  /** Phase ids this phase may move to. */
  next: string[];
}

export interface BoardKindDef {
  name: string;
  /** Tool description for show_board_item. */
  description: string;
  /** Schema of the item's `content` object. */
  contentSchema: JsonSchema;
}

export interface TaxonomyConcept {
  key: string;
  title: string;
}
export interface TaxonomyCategory {
  key: string;
  title: string;
  concepts: TaxonomyConcept[];
}

export interface PromptTemplates {
  /** Placeholders: {{phases}} {{tools}} {{concepts}} {{board}} (kinds). Must not depend on the
   *  phase: it stays byte-identical for the whole session (prompt cache, replayed thinking). */
  system: string;
  /** Current phase block, sent as a system message right after the current turn.
   *  Placeholders: {{phase}} {{phaseInstructions}} (that phase's instructions only). */
  phase: string;
  /** Appended after the tool results when set_phase succeeds mid-reply (append-only).
   *  Placeholders: {{phase}} {{phaseInstructions}}. */
  phaseChange: string;
  /** The tutor speaks first: instruction for the opening reply (no student turn yet). */
  opening: string;
  /** Placeholders: {{learner}} {{memory}} {{task}} {{phase}} {{board}}. */
  context: string;
  /** Prompt for the background memory extractor (module). */
  extraction: string;
  /** Prompt for the end-of-session summary (module). */
  summary: string;
}

// ---- Content library (seed data, loaded into public read-only tables by init) ----

export interface StepDef {
  /** LaTeX for the board. */
  show: string;
  /** Plain words for speech. */
  say: string;
}
export interface TaskStep extends StepDef {
  /** Expected intermediate answer, checkable. */
  expected?: string;
  /** Question the tutor asks when the student is stuck on this step. */
  hint?: string;
}
export interface LibraryCategory {
  key: string;
  title: string;
  position: number;
}
export interface LibraryConcept {
  key: string;
  category: string;
  title: string;
  language: string;
  gradeBand: string;
  dependsOn: string[];
  summary: string;
}
export interface LibrarySkill {
  /** Globally unique, e.g. "fractions-expand/given-factor". */
  key: string;
  concept: string;
  position: number;
  title: string;
  kind: 'compute' | 'explain';
  steps: StepDef[];
  keyStepIndex: number;
  commonMistake: string;
  tutorNote: string;
}
export interface LibraryBoardItem {
  kind: string;
  content: Record<string, unknown>;
}
export interface LibraryExplanation {
  id: string;
  concept: string;
  /** '' = whole concept. */
  skill: string;
  kind: 'intuition' | 'rule' | 'misconception';
  say: string;
  boardItems: LibraryBoardItem[];
}
export interface LibraryTask {
  key: string;
  skill: string;
  type: 'worked_example' | 'repair' | 'gap' | 'solo' | 'follow_up';
  difficulty: 1 | 2 | 3;
  show: string;
  say: string;
  answer: { form: 'number' | 'fraction' | 'choice' | 'text'; value: string };
  steps: TaskStep[];
  /** Repair tasks only: index of the wrong step; -1 otherwise. */
  wrongStepIndex: number;
}
export interface ContentLibrary {
  categories: LibraryCategory[];
  concepts: LibraryConcept[];
  skills: LibrarySkill[];
  explanations: LibraryExplanation[];
  tasks: LibraryTask[];
}

export interface LessonPack {
  version: string;
  phases: PhaseDef[];
  /** Phase every session starts in. */
  initialPhase: string;
  /** Phase that must be last (hand-back). Nothing may follow it. */
  finalPhase: string;
  boardKinds: BoardKindDef[];
  /** At most 10 categories. */
  taxonomy: TaxonomyCategory[];
  prompts: PromptTemplates;
  content: ContentLibrary;
}
