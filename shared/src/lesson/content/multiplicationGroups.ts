import { type ConceptBundle, step, tstep, num, skillTasks } from './helpers';

const C = 'multiplication-groups';
const GROUPS = `${C}/equal-groups`;
const REPEAT = `${C}/repeated-addition`;

export const multiplicationGroups: ConceptBundle = {
  concept: {
    key: C,
    category: 'multiply-divide',
    title: 'Multiplication as equal groups',
    language: 'en',
    gradeBand: '2-3',
    dependsOn: [],
    summary: 'Multiplying means equal groups: four times three is four groups with three in each.',
  },
  skills: [
    {
      key: GROUPS,
      concept: C,
      position: 1,
      title: 'Count equal groups with times',
      kind: 'compute',
      steps: [
        step('\\text{groups}', 'Count the groups.'),
        step('\\text{in each group}', 'Count how many are in each group.'),
        step('\\text{groups} \\cdot \\text{in each}', 'Multiply: groups times how many in each.'),
      ],
      keyStepIndex: 2,
      commonMistake: 'Adds the two numbers (4 + 3) instead of making 4 groups of 3.',
      tutorNote: 'Let the student draw the groups or count them out loud: three, six, nine, twelve.',
    },
    {
      key: REPEAT,
      concept: C,
      position: 2,
      title: 'Times as repeated addition',
      kind: 'compute',
      steps: [
        step('a \\cdot b = b + b + \\dots + b', 'a times b means adding b, a times.'),
        step('\\text{add them up}', 'Add them up.'),
      ],
      keyStepIndex: 0,
      commonMistake: 'Writes 4 times 5 as 4 + 5, or adds the number the wrong number of times.',
      tutorNote: 'Ask: how many groups are there? Then write that many equal numbers.',
    },
  ],
  explanations: [
    {
      id: `${C}/intuition`,
      concept: C,
      skill: '',
      kind: 'intuition',
      say: 'Picture four bags. Each bag has three apples. Count them: three, six, nine, twelve. Four times three is twelve.',
      boardItems: [
        { kind: 'visual', content: { visual: 'groups', groups: 4, perGroup: 3, item: '🍎', caption: '4 bags with 3 apples each' } },
        { kind: 'equation', content: { latex: '4 \\cdot 3 = 3 + 3 + 3 + 3 = 12' } },
      ],
    },
    {
      id: `${C}/rule`,
      concept: C,
      skill: GROUPS,
      kind: 'rule',
      say: 'Number of groups times how many are in each group gives the total.',
      boardItems: [{ kind: 'equation', content: { latex: '\\text{groups} \\cdot \\text{in each} = \\text{total}' } }],
    },
    {
      id: `${C}/misconception`,
      concept: C,
      skill: GROUPS,
      kind: 'misconception',
      say: 'Four plus three is only seven. But four bags with three apples each are twelve apples. Times means equal groups.',
      boardItems: [
        { kind: 'equation', content: { latex: '4 \\cdot 3 \\neq 4 + 3', caption: 'Times is not plus' } },
        { kind: 'visual', content: { visual: 'groups', groups: 4, perGroup: 3, item: '🍎' } },
      ],
    },
  ],
  tasks: [
    ...skillTasks(GROUPS, {
      worked: {
        difficulty: 1,
        show: '\\text{4 bags with 3 apples each. How many apples?}',
        say: 'Four bags with three apples each. How many apples are there?',
        answer: num('12'),
        steps: [
          tstep('3 + 3 + 3 + 3 = 12', 'Count the bags: three, six, nine, twelve.'),
          tstep('4 \\cdot 3 = 12', 'Four groups of three is four times three. That is twelve.', { expected: '12', hint: 'How many groups, and how many in each?' }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Find the mistake: 5 boxes with 2 pencils each}',
        say: 'Five boxes with two pencils each. Someone said there are seven pencils. Can you find the mistake?',
        answer: num('10'),
        wrongStepIndex: 1,
        steps: [
          tstep('5 \\cdot 2', 'Five boxes, two pencils in each: five times two.'),
          tstep('5 \\cdot 2 = 5 + 2 = 7', 'Five and two make seven.', { expected: '10', hint: 'Are we putting two numbers together, or making five groups of two?' }),
        ],
      },
      gap: {
        difficulty: 2,
        show: '\\square \\cdot 4 = 12',
        say: 'How many groups of four make twelve?',
        answer: num('3'),
        steps: [tstep('4 + 4 + 4 = 12', 'Four, eight, twelve. That is three fours.', { expected: '12', hint: 'Count in fours up to twelve.' })],
      },
      solo: [
        {
          difficulty: 1,
          show: '\\text{3 plates with 5 cookies each. How many cookies?}',
          say: 'Three plates with five cookies each. How many cookies are there?',
          answer: num('15'),
          steps: [tstep('3 \\cdot 5 = 15', 'Three groups of five is fifteen.', { expected: '15', hint: 'How many plates, and how many on each?' })],
        },
        {
          difficulty: 2,
          show: '\\text{6 cars with 4 wheels each. How many wheels?}',
          say: 'Six cars with four wheels each. How many wheels are there?',
          answer: num('24'),
          steps: [tstep('6 \\cdot 4 = 24', 'Six groups of four is twenty-four.', { expected: '24', hint: 'How many cars, and how many wheels on each?' })],
        },
      ],
    }),
    ...skillTasks(REPEAT, {
      worked: {
        difficulty: 1,
        show: '\\text{Write } 3 \\cdot 4 \\text{ as an addition and solve}',
        say: 'Write three times four as an addition, then solve it.',
        answer: num('12'),
        steps: [
          tstep('3 \\cdot 4 = 4 + 4 + 4', 'Three times four means three fours.', { hint: 'How many fours do we add?' }),
          tstep('4 + 4 + 4 = 12', 'Four, eight, twelve.', { expected: '12' }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Find the mistake: } 4 \\cdot 5',
        say: 'Someone worked out four times five. Can you find the mistake?',
        answer: num('20'),
        wrongStepIndex: 1,
        steps: [
          tstep('4 \\cdot 5', 'Four times five.'),
          tstep('4 \\cdot 5 = 4 + 5 = 9', 'Four times five is four plus five. That is nine.', { expected: '20', hint: 'How many fives do we need?' }),
        ],
      },
      gap: {
        difficulty: 1,
        show: '3 \\cdot 5 = 5 + 5 + \\square',
        say: 'Three times five is five plus five plus what?',
        answer: num('5'),
        steps: [tstep('3 \\cdot 5 = 15', 'Three times five is fifteen.', { expected: '15', hint: 'How many fives are in three times five?' })],
      },
      solo: [
        {
          difficulty: 1,
          show: '\\text{Write } 2 \\cdot 6 \\text{ as an addition and solve}',
          say: 'Write two times six as an addition, then solve it.',
          answer: num('12'),
          steps: [
            tstep('2 \\cdot 6 = 6 + 6', 'Two times six means two sixes.', { hint: 'How many sixes do we add?' }),
            tstep('6 + 6 = 12', 'Six plus six is twelve.', { expected: '12' }),
          ],
        },
        {
          difficulty: 2,
          show: '\\text{Write } 5 \\cdot 3 \\text{ as an addition and solve}',
          say: 'Write five times three as an addition, then solve it.',
          answer: num('15'),
          steps: [
            tstep('5 \\cdot 3 = 3 + 3 + 3 + 3 + 3', 'Five times three means five threes.', { hint: 'How many threes do we add?' }),
            tstep('3 + 3 + 3 + 3 + 3 = 15', 'Three, six, nine, twelve, fifteen.', { expected: '15' }),
          ],
        },
      ],
    }),
  ],
};
