import type { PhaseDef } from '../types';

// Placeholder phases (spec "User flow and lesson phases"). Allowed moves: forward to any
// later phase, or back to diagnose / intuition / worked_example. hand_back is last.
const ORDER = ['diagnose', 'intuition', 'formalize', 'worked_example', 'repair', 'solo_task', 'follow_up', 'hand_back'];
const BACK_TARGETS = ['diagnose', 'intuition', 'worked_example'];

const META: Record<string, { label: string; description: string }> = {
  diagnose: { label: 'Diagnose', description: 'Recurse down from the task to the underlying concept the student is missing. Ask short questions, walk the skill ladder down.' },
  intuition: { label: 'Intuition', description: 'Metaphorical, intuitive explanation, usually with a visual on the board.' },
  formalize: { label: 'Formalize', description: 'Connect the intuition to notation and the rule.' },
  worked_example: { label: 'Worked example', description: 'Walk through one example step by step, with worked_steps on the board.' },
  repair: { label: 'Repair', description: 'The student fixes a wrongly solved example, or fills a gap task.' },
  solo_task: { label: 'Solo task', description: 'The student solves a similar task alone. Give hints only when asked or stuck.' },
  follow_up: { label: 'Follow-up', description: 'Follow-up questions or related topics.' },
  hand_back: { label: 'Hand back', description: 'The student returns to the original task and solves it themselves. Never solve it for them.' },
};

export const phases: PhaseDef[] = ORDER.map((id, i) => ({
  id,
  ...META[id]!,
  next: i === ORDER.length - 1 ? [] : [...new Set([...ORDER.slice(i + 1), ...BACK_TARGETS.filter(b => b !== id)])],
}));

export const initialPhase = ORDER[0]!;
export const finalPhase = ORDER[ORDER.length - 1]!;
