import { type ConceptBundle, step, tstep, num, frac, choice, skillTasks } from './helpers';

const C = 'decimals-tenths';
const TENTHS = `${C}/tenths`;
const COMPARE = `${C}/compare-decimals`;

export const decimalsTenths: ConceptBundle = {
  concept: {
    key: C,
    category: 'decimals',
    title: 'Tenths and hundredths',
    language: 'en',
    gradeBand: '4-5',
    dependsOn: ['fractions-unit', 'place-value'],
    summary: 'The first place after the point counts tenths, the second hundredths. 0.5 is five tenths.',
  },
  skills: [
    {
      key: TENTHS,
      concept: C,
      position: 1,
      title: 'Tenths after the point',
      kind: 'compute',
      steps: [
        step('1 = \\frac{10}{10}', 'One whole is ten tenths.'),
        step('0.1 = \\frac{1}{10}', 'Zero point one is one tenth.'),
        step('0.d = \\frac{d}{10}', 'The digit right after the point counts tenths.'),
      ],
      keyStepIndex: 2,
      commonMistake: 'Reads 0.5 as one fifth, or as "five" without the point.',
      tutorNote: 'Use dimes: ten dimes make a dollar, so one dime is one tenth of a dollar.',
    },
    {
      key: COMPARE,
      concept: C,
      position: 2,
      title: 'Compare decimals',
      kind: 'compute',
      steps: [
        step('\\text{line up the points}', 'Line up the decimal points.'),
        step('0.3 = 0.30', 'Fill in zeros so both numbers have the same number of places.'),
        step('\\text{tenths first, then hundredths}', 'Compare the tenths first, then the hundredths.'),
      ],
      keyStepIndex: 1,
      commonMistake: 'Thinks 0.25 > 0.3 because 25 > 3.',
      tutorNote: 'Say both numbers in hundredths: thirty hundredths and twenty-five hundredths. Or use money: thirty cents and twenty-five cents.',
    },
  ],
  explanations: [
    {
      id: `${C}/intuition`,
      concept: C,
      skill: '',
      kind: 'intuition',
      say:
        'Ten dimes make one dollar. So one dime is one tenth of a dollar. ' +
        'Five dimes are half a dollar. We write that as zero point five: five tenths.',
      boardItems: [
        { kind: 'visual', content: { visual: 'fraction_bar', parts: 10, shaded: 5, label: '0.5', caption: '5 of 10 dimes' } },
        {
          kind: 'visual',
          content: { visual: 'number_line', min: 0, max: 1, marks: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1], highlight: 0.5 },
        },
      ],
    },
    {
      id: `${C}/rule`,
      concept: C,
      skill: TENTHS,
      kind: 'rule',
      say: 'The first digit after the point counts tenths. The second digit counts hundredths.',
      boardItems: [{ kind: 'equation', content: { latex: '0.7 = \\frac{7}{10} \\qquad 0.07 = \\frac{7}{100}' } }],
    },
    {
      id: `${C}/misconception`,
      concept: C,
      skill: COMPARE,
      kind: 'misconception',
      say:
        'Zero point two five is not bigger than zero point three. Three tenths is thirty hundredths. ' +
        'Thirty hundredths is more than twenty-five hundredths.',
      boardItems: [
        { kind: 'equation', content: { latex: '0.25 < 0.30' } },
        { kind: 'visual', content: { visual: 'area_grid', rows: 10, cols: 10, shaded: 25, caption: '0.25' } },
        { kind: 'visual', content: { visual: 'area_grid', rows: 10, cols: 10, shaded: 30, caption: '0.30' } },
      ],
    },
  ],
  tasks: [
    ...skillTasks(TENTHS, {
      worked: {
        difficulty: 1,
        show: '\\text{How many tenths are in } 0.7\\text{?}',
        say: 'How many tenths are in zero point seven?',
        answer: num('7'),
        steps: [
          tstep('0.7 = \\frac{7}{10}', 'Zero point seven is seven tenths.', { expected: '7/10', hint: 'What does the digit after the point count?' }),
          tstep('0.7 \\cdot 10 = 7', 'Ten times zero point seven is seven. So there are seven tenths.', { expected: '7' }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Someone wrote } 0.5 = \\frac{1}{5}\\text{. Fix it.}',
        say: 'Someone wrote that zero point five is one fifth. Can you fix it?',
        answer: frac('5/10'),
        wrongStepIndex: 1,
        steps: [
          tstep('0.1 = \\frac{1}{10}', 'Zero point one is one tenth.'),
          tstep('0.5 = \\frac{1}{5}', 'Zero point five has a five, so it is one fifth.', {
            expected: '5/10',
            hint: 'What does the digit after the point count?',
          }),
        ],
      },
      gap: {
        difficulty: 1,
        show: '0.5 = \\frac{\\square}{10}',
        say: 'Zero point five is how many tenths?',
        answer: num('5'),
        steps: [tstep('0.5 \\cdot 10 = 5', 'Ten times zero point five is five.', { expected: '5', hint: 'What does the digit after the point count?' })],
      },
      solo: [
        {
          difficulty: 1,
          show: '\\text{Write } 0.3 \\text{ as a fraction}',
          say: 'Write zero point three as a fraction.',
          answer: frac('3/10'),
          steps: [tstep('0.3 = \\frac{3}{10}', 'Zero point three is three tenths.', { expected: '3/10', hint: 'How many tenths is it?' })],
        },
        {
          difficulty: 1,
          show: '\\text{How many tenths are in } 0.9\\text{?}',
          say: 'How many tenths are in zero point nine?',
          answer: num('9'),
          steps: [tstep('0.9 \\cdot 10 = 9', 'Ten times zero point nine is nine.', { expected: '9', hint: 'What does the digit after the point count?' })],
        },
      ],
    }),
    ...skillTasks(COMPARE, {
      worked: {
        difficulty: 2,
        show: '0.25 \\square 0.3',
        say: 'Is zero point two five smaller than, bigger than, or equal to zero point three?',
        answer: choice('<'),
        steps: [
          tstep('0.3 = 0.30', 'Zero point three is the same as zero point three zero.', { hint: 'Can we give both numbers two places?' }),
          tstep('0.25 < 0.30', 'Twenty-five hundredths is less than thirty hundredths.', { expected: '<' }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Someone wrote } 0.15 > 0.4\\text{. Fix it.}',
        say: 'Someone wrote that zero point one five is bigger than zero point four, because fifteen is more than four. Can you fix it?',
        answer: choice('<'),
        wrongStepIndex: 1,
        steps: [
          tstep('0.4 = 0.40', 'Zero point four is zero point four zero.'),
          tstep('0.15 > 0.40', 'Fifteen is more than four, so zero point one five is bigger.', {
            expected: '<',
            hint: 'Compare the tenths first. How many tenths does each have?',
          }),
        ],
      },
      gap: {
        difficulty: 2,
        show: '0.6 \\square 0.45',
        say: 'Is zero point six smaller than, bigger than, or equal to zero point four five?',
        answer: choice('>'),
        steps: [tstep('0.6 = 0.60', 'Zero point six is sixty hundredths.', { hint: 'Can we give both numbers two places?' })],
      },
      solo: [
        {
          difficulty: 2,
          show: '0.7 \\square 0.65',
          say: 'Is zero point seven smaller than, bigger than, or equal to zero point six five?',
          answer: choice('>'),
          steps: [
            tstep('0.7 = 0.70', 'Zero point seven is seventy hundredths.', { hint: 'Can we give both numbers two places?' }),
            tstep('0.70 > 0.65', 'Seventy hundredths is more than sixty-five hundredths.', { expected: '>' }),
          ],
        },
        {
          difficulty: 3,
          show: '0.08 \\square 0.1',
          say: 'Is zero point zero eight smaller than, bigger than, or equal to zero point one?',
          answer: choice('<'),
          steps: [
            tstep('0.1 = 0.10', 'Zero point one is ten hundredths.', { hint: 'Can we give both numbers two places?' }),
            tstep('0.08 < 0.10', 'Eight hundredths is less than ten hundredths.', { expected: '<' }),
          ],
        },
      ],
    }),
  ],
};
