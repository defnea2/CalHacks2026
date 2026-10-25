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
  guide: `You own this lesson: lead, do not wait for the learner to steer. Never open with a question or a diagnosis; the original question and anything the learner said are your diagnosis. Each moment makes ONE visible change and its narration talks about exactly that change, so the picture moves while the child hears about it. Short concrete sentences for an 8 to 12 year old. Prefer the library material when it is given: its picture, numbers, steps and common mistake are checked.`,
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
      guide: `Moment 1: show the concrete picture of a similar example (not the homework itself). Moment 2: make the key change on the SAME picture and say why the amount stays or changes. Moment 3 (formalization): say the rule in kid words and point at which number is which part of the picture; code shows the equation now, so read it out ("two thirds equals eight twelfths"). Optional moment 4: the rule on a second quick example. Final moment: a fresh, similar task on the picture; the check is that task (choice or number), its answer not visible.`,
    },
    {
      id: 'repair',
      phases: ['repair'],
      minMoments: 3,
      maxMoments: 3,
      maxWords: 60,
      formalizeAt: -1,
      check: true,
      checkKinds: ['choice', 'number'],
      next: { correct: ['return_to_problem'], other: ['return_to_problem'], help: ['intuition'] },
      guide: `The learner missed the task or was unsure. No blame. Moment 1: back to the picture with smaller numbers. Moment 2: show the one step they missed. Final moment: one easier task (choice preferred) with a new question.`,
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
      guide: `Praise how they worked, then hand back the original question in one or two short sentences: they now have everything they need. Never solve it or give its answer.`,
    },
  ],
};

export const arcs: Record<string, unknown> = { demo2min };
