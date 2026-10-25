import { type ConceptBundle, step, tstep, num, skillTasks } from './helpers';

const C = 'division-sharing';
const SHARE = `${C}/fair-share`;
const REST = `${C}/remainder`;

export const divisionSharing: ConceptBundle = {
  concept: {
    key: C,
    category: 'multiply-divide',
    title: 'Division as fair sharing',
    language: 'en',
    gradeBand: '3-4',
    dependsOn: ['multiplication-groups'],
    summary: 'Dividing means sharing fairly: everyone gets the same. What cannot be shared fairly is the remainder.',
  },
  skills: [
    {
      key: SHARE,
      concept: C,
      position: 1,
      title: 'Share fairly',
      kind: 'compute',
      steps: [
        step('\\text{total} \\div \\text{people}', 'Share the total fairly among the people.'),
        step('\\text{people} \\cdot \\square = \\text{total}', 'Ask: the number of people times what makes the total?'),
        step('\\text{everyone gets the same}', 'Check that everyone gets the same.'),
      ],
      keyStepIndex: 1,
      commonMistake: 'Hands out unequal shares, or guesses the share without checking with times.',
      tutorNote: 'Deal out one at a time, like cards. Then check the share with a multiplication.',
    },
    {
      key: REST,
      concept: C,
      position: 2,
      title: 'Find the remainder',
      kind: 'compute',
      steps: [
        step('\\text{people} \\cdot \\text{share} \\le \\text{total}', 'Find the biggest fair share that still fits.'),
        step('\\text{total} - \\text{people} \\cdot \\text{share}', 'Take away what was handed out.'),
        step('\\text{remainder} < \\text{people}', 'What is left must be less than the number of people.'),
      ],
      keyStepIndex: 2,
      commonMistake: 'Ignores the leftover, or gives it to one friend so the shares are not equal.',
      tutorNote: 'Ask: could we give everyone one more? If not, what is left is the remainder.',
    },
  ],
  explanations: [
    {
      id: `${C}/intuition`,
      concept: C,
      skill: '',
      kind: 'intuition',
      say:
        'Twelve cookies, three friends. Give each friend one cookie, again and again, until the cookies are gone. ' +
        'Each friend gets four. That is twelve divided by three.',
      boardItems: [
        { kind: 'visual', content: { visual: 'groups', groups: 3, perGroup: 4, item: '🍪', caption: '12 cookies shared by 3 friends' } },
        { kind: 'equation', content: { latex: '12 \\div 3 = 4' } },
      ],
    },
    {
      id: `${C}/rule`,
      concept: C,
      skill: SHARE,
      kind: 'rule',
      say: 'Dividing asks how many each one gets when we share fairly. We can check it with times.',
      boardItems: [{ kind: 'equation', content: { latex: '12 \\div 3 = 4 \\quad \\text{because} \\quad 3 \\cdot 4 = 12' } }],
    },
    {
      id: `${C}/misconception`,
      concept: C,
      skill: REST,
      kind: 'misconception',
      say:
        'Fair means everyone gets the same. If two cookies are left, we cannot just forget them. ' +
        'And we cannot give them to one friend. They are the remainder.',
      boardItems: [
        { kind: 'equation', content: { latex: '14 = 4 \\cdot 3 + 2', caption: '2 left over: the remainder' } },
        { kind: 'text', content: { text: 'The remainder is always smaller than the number of friends.' } },
      ],
    },
  ],
  tasks: [
    ...skillTasks(SHARE, {
      worked: {
        difficulty: 1,
        show: '\\text{Share 12 cookies fairly among 3 friends}',
        say: 'Share twelve cookies fairly among three friends. How many does each friend get?',
        answer: num('4'),
        steps: [
          tstep('3 \\cdot 4 = 12', 'Three friends times four cookies is twelve.', { hint: 'Three times what is twelve?' }),
          tstep('12 \\div 3 = 4', 'So each friend gets four.', { expected: '4' }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Find the mistake: share 15 stickers among 3 friends}',
        say: 'Someone shared fifteen stickers among three friends and gave out six, five and four. Can you find the mistake?',
        answer: num('5'),
        wrongStepIndex: 1,
        steps: [
          tstep('6 + 5 + 4 = 15', 'Six plus five plus four is fifteen. All stickers are handed out.'),
          tstep('15 \\div 3 = 6', 'So each friend gets six.', { expected: '5', hint: 'Did every friend get the same?' }),
        ],
      },
      gap: {
        difficulty: 1,
        show: '20 \\div 4 = \\square',
        say: 'Twenty shared by four is how much each?',
        answer: num('5'),
        steps: [tstep('4 \\cdot 5 = 20', 'Four times five is twenty.', { expected: '20', hint: 'Four times what is twenty?' })],
      },
      solo: [
        {
          difficulty: 1,
          show: '\\text{Share 18 marbles fairly among 3 friends}',
          say: 'Share eighteen marbles fairly among three friends. How many does each friend get?',
          answer: num('6'),
          steps: [
            tstep('3 \\cdot 6 = 18', 'Three times six is eighteen.', { hint: 'Three times what is eighteen?' }),
            tstep('18 \\div 3 = 6', 'So each friend gets six.', { expected: '6' }),
          ],
        },
        {
          difficulty: 2,
          show: '\\text{Share 24 cards fairly among 4 friends}',
          say: 'Share twenty-four cards fairly among four friends. How many does each friend get?',
          answer: num('6'),
          steps: [
            tstep('4 \\cdot 6 = 24', 'Four times six is twenty-four.', { hint: 'Four times what is twenty-four?' }),
            tstep('24 \\div 4 = 6', 'So each friend gets six.', { expected: '6' }),
          ],
        },
      ],
    }),
    ...skillTasks(REST, {
      worked: {
        difficulty: 2,
        show: '\\text{Share 14 cookies among 4 friends. How many are left over?}',
        say: 'Share fourteen cookies among four friends. How many are left over?',
        answer: num('2'),
        steps: [
          tstep('4 \\cdot 3 = 12', 'Each friend gets three. Four times three is twelve.', { expected: '12', hint: 'How many can each friend get?' }),
          tstep('4 \\cdot 4 = 16 > 14', 'Four each would need sixteen. That is too many.'),
          tstep('14 - 12 = 2', 'Fourteen minus twelve is two. Two are left over.', { expected: '2', hint: 'How many did we hand out?' }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Find the mistake: share 17 marbles among 5 friends}',
        say: 'Someone shared seventeen marbles among five friends and said nothing is left over. Can you find the mistake?',
        answer: num('2'),
        wrongStepIndex: 1,
        steps: [
          tstep('5 \\cdot 3 = 15', 'Each friend gets three. Five times three is fifteen.', { expected: '15' }),
          tstep('17 - 15 = 0', 'So nothing is left over.', { expected: '2', hint: 'How many did we hand out, and how many did we have?' }),
        ],
      },
      gap: {
        difficulty: 2,
        show: '13 = 4 \\cdot 3 + \\square',
        say: 'Thirteen is four times three plus what?',
        answer: num('1'),
        steps: [tstep('4 \\cdot 3 = 12', 'Four times three is twelve.', { expected: '12', hint: 'What is four times three?' })],
      },
      solo: [
        {
          difficulty: 2,
          show: '\\text{Share 11 apples among 3 friends. How many are left over?}',
          say: 'Share eleven apples among three friends. How many are left over?',
          answer: num('2'),
          steps: [
            tstep('3 \\cdot 3 = 9', 'Each friend gets three. Three times three is nine.', { expected: '9', hint: 'How many can each friend get?' }),
            tstep('11 - 9 = 2', 'Eleven minus nine is two.', { expected: '2', hint: 'How many did we hand out?' }),
          ],
        },
        {
          difficulty: 3,
          show: '\\text{Share 23 cards among 5 friends. How many does each friend get?}',
          say: 'Share twenty-three cards fairly among five friends. How many does each friend get?',
          answer: num('4'),
          steps: [
            tstep('5 \\cdot 5 = 25 > 23', 'Five each would need twenty-five. Too many.', { hint: 'Can everyone get five?' }),
            tstep('5 \\cdot 4 = 20 < 23', 'Four each needs twenty. That fits, and three are left over.'),
            tstep('20 \\div 5 = 4', 'So each friend gets four.', { expected: '4' }),
          ],
        },
      ],
    }),
  ],
};
