// Small builders that keep the seed content files readable. Output is plain library data.
import type { LibraryConcept, LibraryExplanation, LibrarySkill, LibraryTask, StepDef, TaskStep } from '../types';

/** Everything the library holds for one concept. */
export interface ConceptBundle {
  concept: LibraryConcept;
  skills: LibrarySkill[];
  explanations: LibraryExplanation[];
  tasks: LibraryTask[];
}

/** A general skill step: LaTeX for the board, plain words for speech. */
export const step = (show: string, say: string): StepDef => ({ show, say });

/** A task step with optional checkable `expected` value and the `hint` question for when the student is stuck. */
export const tstep = (show: string, say: string, extra: { expected?: string; hint?: string } = {}): TaskStep => ({ show, say, ...extra });

export const num = (value: string): LibraryTask['answer'] => ({ form: 'number', value });
export const frac = (value: string): LibraryTask['answer'] => ({ form: 'fraction', value });
export const choice = (value: string): LibraryTask['answer'] => ({ form: 'choice', value });
export const text = (value: string): LibraryTask['answer'] => ({ form: 'text', value });

type TaskInput = Pick<LibraryTask, 'difficulty' | 'show' | 'say' | 'answer' | 'steps'>;

/** The standard task set per skill: worked example, repair, gap and two solo tasks. */
export function skillTasks(
  skill: string,
  t: { worked: TaskInput; repair: TaskInput & { wrongStepIndex: number }; gap: TaskInput; solo: [TaskInput, TaskInput] },
): LibraryTask[] {
  const { wrongStepIndex, ...repair } = t.repair;
  return [
    { key: `${skill}/worked`, skill, type: 'worked_example', wrongStepIndex: -1, ...t.worked },
    { key: `${skill}/repair`, skill, type: 'repair', wrongStepIndex, ...repair },
    { key: `${skill}/gap`, skill, type: 'gap', wrongStepIndex: -1, ...t.gap },
    { key: `${skill}/solo-1`, skill, type: 'solo', wrongStepIndex: -1, ...t.solo[0] },
    { key: `${skill}/solo-2`, skill, type: 'solo', wrongStepIndex: -1, ...t.solo[1] },
  ];
}
