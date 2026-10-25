import type { PhaseDef } from '../types';

// Placeholder phases (spec "User flow and lesson phases"). Allowed moves: forward to any
// later phase, or back to diagnose / intuition / worked_example. hand_back is last.
const ORDER = ['diagnose', 'intuition', 'formalize', 'worked_example', 'repair', 'solo_task', 'follow_up', 'hand_back'];
const BACK_TARGETS = ['diagnose', 'intuition', 'worked_example'];

// `description` goes into the phase list of every prompt (to choose the next phase).
// `instructions` is the detailed block for the CURRENT phase only ({{phaseInstructions}}).
const META: Record<string, { label: string; description: string; instructions: string }> = {
  diagnose: {
    label: 'Diagnose',
    description: 'Recurse down from the task to the underlying concept the student is missing. Ask short questions, walk the skill ladder down.',
    instructions: `Goal: find the first idea the student cannot do yet. Do not teach yet.
- If you do not know the topic yet, find it out and call set_topic.
- Ask one small diagnostic question at a time. Start close to the task, then go one step simpler each time the student is unsure.
- Use the skill ladder from the library: test the key step of each skill, and listen for the common mistake.
- Ask the student to explain their thinking ("How did you get that?"). Wrong answers are useful clues; never just say "wrong".
- Watch for: guessing, "I don't know", rules said without meaning, mixing up top and bottom numbers.
- Move on when you can name the missing idea in one sentence: usually to intuition. If they only need a reminder of the steps, go to worked_example.`,
  },
  intuition: {
    label: 'Intuition',
    description: 'Metaphorical, intuitive explanation, usually with a visual on the board.',
    instructions: `Goal: the student gets a picture in their head for the missing idea.
- Use one everyday picture (pizza, chocolate bar, number line, groups of apples) and show a matching visual on the board.
- Build the picture together: let the student count, compare or point at parts of the board.
- No rules or notation yet; words and pictures only.
- Watch for: nodding along without understanding. Ask them to say the idea in their own words.
- Move on to formalize when they can explain the picture back to you. If one picture does not help, try a different one before moving on.`,
  },
  formalize: {
    label: 'Formalize',
    description: 'Connect the intuition to notation and the rule.',
    instructions: `Goal: connect the picture to numbers, symbols and the rule.
- Put the math next to the picture on the board (an equation), and point out which number is which part of the picture.
- State the rule in kid words, then ask the student to say it back.
- Explain every new word the first time you use it.
- Watch for: the rule being used without meaning. Ask "Why does that work in our picture?"
- Move on to worked_example once they can link each part of the rule to the picture. Go back to intuition if the picture fell apart.`,
  },
  worked_example: {
    label: 'Worked example',
    description: 'Walk through one example step by step, with worked_steps on the board.',
    instructions: `Goal: show the method once, step by step, on an example that is similar to (but not) the original task.
- Show worked_steps on the board and go through them one at a time.
- Before each step, let the student guess what comes next; then reveal it.
- Spend the most time on the key step.
- Watch for: the student only watching. Give them the easy steps to do.
- Move on to repair or solo_task when they could predict most steps.`,
  },
  repair: {
    label: 'Repair',
    description: 'The student fixes a wrongly solved example, or fills a gap task.',
    instructions: `Goal: the student finds and fixes a mistake, or fills the gaps in a half-done example.
- Show a gap task (always with expectedAnswer) or a wrongly solved example with the common mistake in it.
- Let the student find the problem; give hints as questions, not answers.
- When they fix it, ask why the wrong version was wrong.
- Watch for: fixing by guessing. Ask them to explain their fix.
- Move on to solo_task when they fixed it with little help. Go back to worked_example if they are lost.`,
  },
  solo_task: {
    label: 'Solo task',
    description: 'The student solves a similar task alone. Give hints only when asked or stuck.',
    instructions: `Goal: the student solves a similar task on their own.
- Give one task like the original (same idea, different numbers) on the board.
- Stay quiet while they work; hints only when asked or clearly stuck, smallest hint first.
- When they answer, ask how they got it before you say whether it is right.
- Watch for: the same mistake as at the start. If it comes back, go back to intuition or worked_example.
- Move on when they solved it alone: to follow_up if there is a related idea worth a short look, otherwise to hand_back.`,
  },
  follow_up: {
    label: 'Follow-up',
    description: 'Follow-up questions or related topics.',
    instructions: `Goal: make the new idea stick and answer the student's own questions.
- Ask one "what if" question that stretches the idea a little (bigger numbers, the other way round).
- Answer the student's questions about related topics briefly; do not start a whole new lesson.
- Watch for: tiredness or losing focus. Then go straight to hand_back.
- Move on to hand_back after one or two follow-up questions.`,
  },
  hand_back: {
    label: 'Hand back',
    description: 'The student returns to the original task and solves it themselves. Never solve it for them.',
    instructions: `Goal: the student solves the original homework task alone.
- Remind them of the original task and say they now have everything they need.
- Never solve it or give its answer, not even partly. Hints only as questions that point back to what they learned today.
- Praise how they worked today, not how smart they are.
- When they are done, ask them to say in one sentence what they learned, then wish them well.
- This is the last phase.`,
  },
};

export const phases: PhaseDef[] = ORDER.map((id, i) => ({
  id,
  ...META[id]!,
  next: i === ORDER.length - 1 ? [] : [...new Set([...ORDER.slice(i + 1), ...BACK_TARGETS.filter(b => b !== id)])],
}));

export const initialPhase = ORDER[0]!;
export const finalPhase = ORDER[ORDER.length - 1]!;
