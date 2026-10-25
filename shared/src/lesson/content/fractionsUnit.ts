import { type ConceptBundle, step, tstep, num, frac, skillTasks } from './helpers';

const C = 'fractions-unit';
const EQUAL = `${C}/equal-parts`;
const NAME = `${C}/name-fraction`;

export const fractionsUnit: ConceptBundle = {
  concept: {
    key: C,
    category: 'fractions',
    title: 'What a fraction is',
    language: 'en',
    gradeBand: '3-4',
    dependsOn: ['division-sharing'],
    summary: 'A fraction names equal parts of a whole: the bottom number says how many equal parts, the top how many we take.',
  },
  skills: [
    {
      key: EQUAL,
      concept: C,
      position: 1,
      title: 'Equal parts of a whole',
      kind: 'explain',
      steps: [
        step('\\text{count the parts}', 'Count the parts.'),
        step('\\text{all parts the same size?}', 'Check: are all the parts the same size?'),
        step('\\frac{1}{\\text{number of parts}}', 'Only then is each part one over the number of parts.'),
      ],
      keyStepIndex: 1,
      commonMistake: 'Calls four unequal pieces "quarters".',
      tutorNote: 'Show one fair and one unfair cut of the same pizza. Ask which one would be fair to share.',
    },
    {
      key: NAME,
      concept: C,
      position: 2,
      title: 'Name a fraction',
      kind: 'compute',
      steps: [
        step('\\text{bottom} = \\text{equal parts in the whole}', 'The bottom number is how many equal parts the whole has.'),
        step('\\text{top} = \\text{parts we take}', 'The top number is how many parts we take.'),
        step('\\frac{\\text{top}}{\\text{bottom}}', 'Write the top number over the bottom number.'),
      ],
      keyStepIndex: 0,
      commonMistake: 'Uses the unshaded parts as the bottom number: 3 of 8 shaded becomes 3/5.',
      tutorNote: 'Ask first: how many equal parts does the whole have? Only then count the shaded ones.',
    },
  ],
  explanations: [
    {
      id: `${C}/intuition`,
      concept: C,
      skill: '',
      kind: 'intuition',
      say: 'Cut a pizza into four equal slices. Each slice is one quarter. The bottom number, four, says how many equal slices there are.',
      boardItems: [
        { kind: 'visual', content: { visual: 'fraction_bar', parts: 4, shaded: 1, label: '1/4', caption: 'One of four equal slices' } },
        { kind: 'equation', content: { latex: '\\frac{1}{4}' } },
      ],
    },
    {
      id: `${C}/rule`,
      concept: C,
      skill: NAME,
      kind: 'rule',
      say: 'The bottom number counts the equal parts of the whole. The top number counts the parts we take.',
      boardItems: [{ kind: 'equation', content: { latex: '\\frac{\\text{parts we take}}{\\text{equal parts in the whole}}' } }],
    },
    {
      id: `${C}/misconception`,
      concept: C,
      skill: EQUAL,
      kind: 'misconception',
      say: 'Four pieces are only quarters if they are all the same size. A big piece and a tiny piece are not two halves.',
      boardItems: [
        { kind: 'visual', content: { visual: 'fraction_bar', parts: 2, shaded: 1, label: '1/2', caption: 'Equal parts: real halves' } },
        { kind: 'text', content: { text: 'Fractions need equal parts.' } },
      ],
    },
  ],
  tasks: [
    ...skillTasks(EQUAL, {
      worked: {
        difficulty: 1,
        show: '\\text{A pizza is cut into 4 equal slices. What fraction is one slice?}',
        say: 'A pizza is cut into four equal slices. What fraction of the pizza is one slice?',
        answer: frac('1/4'),
        steps: [
          tstep('\\frac{4}{4} = 1', 'Four quarters make the whole pizza.', { hint: 'How many equal slices make the whole pizza?' }),
          tstep('1 \\div 4 = \\frac{1}{4}', 'One pizza shared into four equal slices: each is one quarter.', { expected: '1/4' }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Find the mistake: a bar of 12 squares is cut into pieces of 3, 4 and 5 squares}',
        say: 'A bar of twelve squares is cut into pieces of three, four and five squares. Someone says each piece is one third. Can you find the mistake?',
        answer: frac('5/12'),
        wrongStepIndex: 1,
        steps: [
          tstep('3 + 4 + 5 = 12', 'Three plus four plus five is twelve squares.', { expected: '12' }),
          tstep('\\frac{5}{12} = \\frac{1}{3}', 'There are three pieces, so the piece of five is one third.', {
            expected: '5/12',
            hint: 'Are the three pieces the same size?',
          }),
        ],
      },
      gap: {
        difficulty: 1,
        show: '\\frac{1}{4} + \\frac{1}{4} + \\frac{1}{4} + \\frac{1}{4} = \\square',
        say: 'Four quarters make how many wholes?',
        answer: num('1'),
        steps: [tstep('\\frac{4}{4} = 1', 'Four quarters are one whole pizza.', { expected: '1', hint: 'How many quarters make a whole pizza?' })],
      },
      solo: [
        {
          difficulty: 1,
          show: '\\text{A cake is cut into 3 equal pieces. What fraction is one piece?}',
          say: 'A cake is cut into three equal pieces. What fraction of the cake is one piece?',
          answer: frac('1/3'),
          steps: [tstep('1 \\div 3 = \\frac{1}{3}', 'One cake in three equal pieces: each is one third.', { expected: '1/3', hint: 'How many equal pieces are there?' })],
        },
        {
          difficulty: 2,
          show: '\\square \\cdot \\frac{1}{6} = 1',
          say: 'How many sixths make one whole?',
          answer: num('6'),
          steps: [tstep('\\frac{6}{6} = 1', 'Six sixths are one whole.', { expected: '1', hint: 'Into how many equal parts is the whole cut?' })],
        },
      ],
    }),
    ...skillTasks(NAME, {
      worked: {
        difficulty: 1,
        show: '\\text{A bar has 5 equal parts. 2 are shaded. What fraction is shaded?}',
        say: 'A bar has five equal parts. Two are shaded. What fraction is shaded?',
        answer: frac('2/5'),
        steps: [
          tstep('\\text{bottom} = 5', 'There are five equal parts. Five goes at the bottom.', { hint: 'How many equal parts does the whole bar have?' }),
          tstep('\\text{top} = 2', 'Two parts are shaded. Two goes on top.'),
          tstep('2 \\cdot \\frac{1}{5} = \\frac{2}{5}', 'Two of the fifths: two fifths.', { expected: '2/5' }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Find the mistake: 8 equal parts, 3 shaded}',
        say: 'A bar has eight equal parts and three are shaded. Someone wrote three fifths. Can you find the mistake?',
        answer: frac('3/8'),
        wrongStepIndex: 1,
        steps: [
          tstep('8 - 3 = 5', 'Five parts are not shaded.', { expected: '5' }),
          tstep('3 \\cdot \\frac{1}{8} = \\frac{3}{5}', 'Three shaded over five not shaded: three fifths.', {
            expected: '3/8',
            hint: 'How many equal parts does the whole bar have?',
          }),
        ],
      },
      gap: {
        difficulty: 1,
        show: '3 \\cdot \\frac{1}{6} = \\frac{\\square}{6}',
        say: 'Three sixths: three times one sixth is how many sixths?',
        answer: num('3'),
        steps: [tstep('\\frac{1}{6} + \\frac{1}{6} + \\frac{1}{6} = \\frac{3}{6}', 'One sixth, two sixths, three sixths.', { expected: '3/6' })],
      },
      solo: [
        {
          difficulty: 1,
          show: '\\text{A bar has 4 equal parts. 3 are shaded. What fraction is shaded?}',
          say: 'A bar has four equal parts. Three are shaded. What fraction is shaded?',
          answer: frac('3/4'),
          steps: [tstep('3 \\cdot \\frac{1}{4} = \\frac{3}{4}', 'Three of the quarters: three quarters.', { expected: '3/4', hint: 'How many equal parts does the whole have?' })],
        },
        {
          difficulty: 2,
          show: '\\text{A bar has 10 equal parts. 7 are shaded. What fraction is shaded?}',
          say: 'A bar has ten equal parts. Seven are shaded. What fraction is shaded?',
          answer: frac('7/10'),
          steps: [tstep('7 \\cdot \\frac{1}{10} = \\frac{7}{10}', 'Seven of the tenths: seven tenths.', { expected: '7/10', hint: 'What goes at the bottom?' })],
        },
      ],
    }),
  ],
};
