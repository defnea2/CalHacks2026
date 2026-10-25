// Lesson arcs (team planner phases, @tutor/teaching/teaching/arc.ts interprets them). The module
// picks one by LESSON_ARC (default `demo2min`); `adaptive` = no arc, the team's adaptive policy.
//
// demo2min (Can's task): a rigid lesson that is demonstrable in two minutes. The tutor owns the
// initial explanation: no diagnostic question first; one connected, keyframed picture lesson whose
// third moment is the formalization (code shows the equation on that moment) and whose final
// moment hands the learner one task. Worst case (the learner says little or "I don't know"):
// explanation, formalization and task are all inside that first step, about 50 s of audio after
// the authored opening. A missed task gets ONE short repair with a smaller task, then hand back.

export const DEFAULT_ARC = 'demo2min';
/** LESSON_ARC value for "no arc" (the previous adaptive behaviour). */
export const ADAPTIVE_ARC = 'adaptive';

/** Plain data; parsed (validated) with LessonArcSchema of @tutor/teaching where it is used. */
const demo2min = {
  id: 'demo2min',
  label: 'Two-minute demo lesson',
  budgetSeconds: 120,
  wordsPerSecond: 2.6,
  start: ['intuition'],
  fallback: ['return_to_problem'],
  guide: `You own this lesson: lead, do not wait for the learner to steer. Never open with a question or a diagnosis; the original question and anything the learner said are your diagnosis. Each moment makes ONE visible change and its narration talks about exactly that change, so the picture moves while the child hears about it. Short concrete sentences for an 8 to 12 year old. Prefer the library material when it is given: its picture, numbers, steps and common mistake are checked. Every task (check): its answer is never drawn on the board when it is asked (ask about a fraction no bar shows), it never reuses the homework's numbers, a choice task has exactly one correct option, and it is answered by voice ("Say...", "What is...", never "type", "click" or "tap"). session.decision, when present, is what the learner chose after you double-checked a big change: plan exactly that (the stage guide says how), start from what they asked and keep the picture on the board. resume = they said no and want to go on: continue right where you stopped with the next idea, no recap.`,
  // After the tutor double-checked (teaching/intent.ts) and the learner confirmed.
  decisions: { give_answer: ['return_to_problem'], task_now: ['solo'], hand_back: ['return_to_problem'] },
  stages: [
    {
      id: 'explain',
      phases: ['intuition'],
      minMoments: 4,
      maxMoments: 5,
      maxWords: 115,
      formalizeAt: 2,
      check: true,
      checkKinds: ['choice', 'number'],
      next: { correct: ['return_to_problem'], other: ['repair'], help: ['intuition', 'repair'] },
      guide: `Moment 1: show the concrete picture of a similar example (not the homework itself). Moment 2: make the key change on the SAME picture and say why the amount stays or changes. Moment 3 (formalization): say the rule in kid words and point at which number is which part of the picture; code shows the equation now, so read it out ("two thirds equals eight twelfths"). Optional moment 4: the rule on a second quick example. Final moment: a fresh, similar task on the picture with DIFFERENT numbers than the homework (the homework itself is handed back at the end; never ask it); the check is that task (choice or number), its answer not visible.`,
    },
    {
      id: 'repair',
      phases: ['repair'],
      minMoments: 3,
      maxMoments: 4,
      maxWords: 70,
      formalizeAt: -1,
      check: true,
      checkKinds: ['choice', 'number'],
      next: { correct: ['return_to_problem'], other: ['return_to_problem'], help: ['intuition'] },
      guide: `The learner missed the task or was unsure. No blame. The tutor has already said "You said ... Not quite." (or "That's okay") right before this step: do not repeat it. Moment 1: back to the same picture with smaller numbers, in words that refer to what they said. Moment 2: show the one step they missed. Final moment: one easier task (choice preferred) with a new question whose answer is not on the picture (shown one half = three sixths: ask one third = how many sixths).`,
    },
    {
      id: 'task',
      phases: ['solo'],
      minMoments: 3,
      maxMoments: 4,
      maxWords: 40,
      formalizeAt: -1,
      check: true,
      checkKinds: ['choice', 'number'],
      next: { correct: ['return_to_problem'], other: ['repair'], help: ['intuition', 'repair'] },
      guide: `Only when session.decision is task_now: the learner wants a task right away. Set meta.exampleProblem (required in this phase) to the task in short form, e.g. "3/4 = ?/8". Moment 1: show (or keep) the picture of that example in one sentence. Moment 2: one quick change on it, said plainly. Final moment: ask the task (DIFFERENT numbers than the homework), its answer not visible, no equation shown.`,
    },
    {
      id: 'hand_back',
      phases: ['return_to_problem'],
      minMoments: 1,
      maxMoments: 2,
      maxWords: 40,
      formalizeAt: -1,
      check: false,
      checkKinds: [],
      next: { correct: [], other: [], help: [] },
      guide: `If session.decision is give_answer (the learner asked for the answer and confirmed): one moment, no praise, the tutor already said "Okay, I'll tell you" (do not start with "Okay"). Say the homework's answer in one short sentence with the reason in kid words, and end with exactly "Want to see why it works?". If session.decision is hand_back: they chose to skip; hand the question back warmly, no praise for skipped work. Otherwise: praise how they worked, then hand back the original question in one or two short sentences: they now have everything they need. Never solve it or give its answer.`,
    },
  ],
};

export const arcs: Record<string, unknown> = { demo2min };
