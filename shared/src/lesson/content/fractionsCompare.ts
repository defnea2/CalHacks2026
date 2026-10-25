import { type ConceptBundle, step, tstep, choice, skillTasks } from './helpers';

const C = 'fractions-compare';
const UNIT = `${C}/unit-fractions`;
const SAME = `${C}/same-denominator`;

export const fractionsCompare: ConceptBundle = {
  concept: {
    key: C,
    category: 'fractions',
    title: 'Comparing fractions',
    language: 'en',
    gradeBand: '3-4',
    dependsOn: ['fractions-unit'],
    summary: 'More slices of the same pizza means smaller slices. With the same bottom number, the bigger top number is more.',
  },
  skills: [
    {
      key: UNIT,
      concept: C,
      position: 1,
      title: 'Compare unit fractions',
      kind: 'compute',
      steps: [
        step('\\frac{1}{a} \\text{ and } \\frac{1}{b}', 'Both fractions have one on top.'),
        step('\\text{more parts} \\Rightarrow \\text{smaller parts}', 'More parts means smaller parts.'),
        step('a < b \\Rightarrow \\frac{1}{a} > \\frac{1}{b}', 'The bigger bottom number gives the smaller fraction.'),
      ],
      keyStepIndex: 2,
      commonMistake: 'Thinks 1/4 > 1/3 because 4 > 3.',
      tutorNote: 'Ask: would you rather share a pizza with three friends or with four? Draw both bars the same length.',
    },
    {
      key: SAME,
      concept: C,
      position: 2,
      title: 'Compare with the same denominator',
      kind: 'compute',
      steps: [
        step('\\text{same bottom} \\Rightarrow \\text{same size parts}', 'Same bottom number: the parts are the same size.'),
        step('\\text{compare the tops}', 'Then the bigger top number means more parts.'),
      ],
      keyStepIndex: 1,
      commonMistake: 'Thinks 2/5 and 4/5 are equal because the bottom numbers are the same.',
      tutorNote: 'Same-size slices: just count them. Two slices or four slices, which is more pizza?',
    },
  ],
  explanations: [
    {
      id: `${C}/intuition`,
      concept: C,
      skill: '',
      kind: 'intuition',
      say:
        'Share one pizza with three friends, or with four friends. With four friends, everyone gets a smaller slice. ' +
        'So one quarter is less than one third.',
      boardItems: [
        { kind: 'visual', content: { visual: 'fraction_bar', parts: 3, shaded: 1, label: '1/3', caption: 'Shared by 3' } },
        { kind: 'visual', content: { visual: 'fraction_bar', parts: 4, shaded: 1, label: '1/4', caption: 'Shared by 4: smaller slices' } },
      ],
    },
    {
      id: `${C}/rule`,
      concept: C,
      skill: UNIT,
      kind: 'rule',
      say: 'With one on top, the bigger the bottom number, the smaller the fraction.',
      boardItems: [{ kind: 'equation', content: { latex: '\\frac{1}{4} < \\frac{1}{3} \\quad \\text{because} \\quad 4 > 3' } }],
    },
    {
      id: `${C}/misconception`,
      concept: C,
      skill: UNIT,
      kind: 'misconception',
      say: 'Four is bigger than three, but a quarter is smaller than a third. The bottom number says how many slices, not how big they are.',
      boardItems: [
        { kind: 'equation', content: { latex: '\\frac{1}{4} < \\frac{1}{3}' } },
        { kind: 'text', content: { text: 'Bigger bottom number: more slices, smaller slices.' } },
      ],
    },
  ],
  tasks: [
    ...skillTasks(UNIT, {
      worked: {
        difficulty: 1,
        show: '\\frac{1}{3} \\square \\frac{1}{4}',
        say: 'Is one third smaller than, bigger than, or equal to one quarter?',
        answer: choice('>'),
        steps: [
          tstep('3 < 4', 'Three is less than four. Thirds are fewer parts.', { hint: 'Which pizza is cut into more slices?' }),
          tstep('\\frac{1}{3} > \\frac{1}{4}', 'Fewer parts means bigger parts. So one third is bigger.', { expected: '>' }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Someone wrote } \\frac{1}{4} > \\frac{1}{3}\\text{. Fix it.}',
        say: 'Someone wrote that one quarter is bigger than one third. Can you fix it?',
        answer: choice('<'),
        wrongStepIndex: 1,
        steps: [
          tstep('4 > 3', 'Four is more than three.'),
          tstep('\\frac{1}{4} > \\frac{1}{3}', 'So one quarter is bigger than one third.', {
            expected: '<',
            hint: 'If you cut a pizza into more slices, are the slices bigger or smaller?',
          }),
        ],
      },
      gap: {
        difficulty: 1,
        show: '\\frac{1}{6} \\square \\frac{1}{2}',
        say: 'Is one sixth smaller than, bigger than, or equal to one half?',
        answer: choice('<'),
        steps: [tstep('\\frac{1}{6} < \\frac{1}{2}', 'Six slices are smaller than two slices of the same pizza.', { expected: '<', hint: 'Which has more slices?' })],
      },
      solo: [
        {
          difficulty: 1,
          show: '\\frac{1}{8} \\square \\frac{1}{5}',
          say: 'Is one eighth smaller than, bigger than, or equal to one fifth?',
          answer: choice('<'),
          steps: [
            tstep('8 > 5', 'Eight slices are more slices than five.', { hint: 'Which pizza is cut into more slices?' }),
            tstep('\\frac{1}{8} < \\frac{1}{5}', 'More slices means smaller slices.', { expected: '<' }),
          ],
        },
        {
          difficulty: 2,
          show: '\\frac{1}{2} \\square \\frac{1}{10}',
          say: 'Is one half smaller than, bigger than, or equal to one tenth?',
          answer: choice('>'),
          steps: [
            tstep('2 < 10', 'Two slices are fewer than ten.', { hint: 'Which pizza is cut into fewer slices?' }),
            tstep('\\frac{1}{2} > \\frac{1}{10}', 'Fewer slices means bigger slices.', { expected: '>' }),
          ],
        },
      ],
    }),
    ...skillTasks(SAME, {
      worked: {
        difficulty: 1,
        show: '\\frac{3}{8} \\square \\frac{5}{8}',
        say: 'Is three eighths smaller than, bigger than, or equal to five eighths?',
        answer: choice('<'),
        steps: [
          tstep('3 < 5', 'Both are eighths, so the slices are the same size. Three slices are fewer than five.', { hint: 'Are the slices the same size?' }),
          tstep('\\frac{3}{8} < \\frac{5}{8}', 'So three eighths is less.', { expected: '<' }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Someone wrote } \\frac{2}{5} = \\frac{4}{5}\\text{. Fix it.}',
        say: 'Someone wrote that two fifths equals four fifths, because the bottom is the same. Can you fix it?',
        answer: choice('<'),
        wrongStepIndex: 1,
        steps: [
          tstep('5 = 5', 'Both have five on the bottom.'),
          tstep('\\frac{2}{5} = \\frac{4}{5}', 'So two fifths equals four fifths.', { expected: '<', hint: 'Two slices or four slices, which is more?' }),
        ],
      },
      gap: {
        difficulty: 1,
        show: '\\frac{7}{10} \\square \\frac{3}{10}',
        say: 'Is seven tenths smaller than, bigger than, or equal to three tenths?',
        answer: choice('>'),
        steps: [tstep('7 > 3', 'Same size slices. Seven slices are more than three.', { expected: '>', hint: 'Are the slices the same size?' })],
      },
      solo: [
        {
          difficulty: 1,
          show: '\\frac{2}{6} \\square \\frac{5}{6}',
          say: 'Is two sixths smaller than, bigger than, or equal to five sixths?',
          answer: choice('<'),
          steps: [tstep('\\frac{2}{6} < \\frac{5}{6}', 'Same size slices. Two are fewer than five.', { expected: '<', hint: 'Compare the top numbers.' })],
        },
        {
          difficulty: 2,
          show: '\\frac{4}{7} \\square \\frac{3}{7}',
          say: 'Is four sevenths smaller than, bigger than, or equal to three sevenths?',
          answer: choice('>'),
          steps: [tstep('\\frac{4}{7} > \\frac{3}{7}', 'Same size slices. Four are more than three.', { expected: '>', hint: 'Compare the top numbers.' })],
        },
      ],
    }),
  ],
};
