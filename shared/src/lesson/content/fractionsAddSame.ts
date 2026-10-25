import { type ConceptBundle, step, tstep, num, frac, skillTasks } from './helpers';

const C = 'fractions-add-same';
const ADD = `${C}/add-numerators`;
const WHOLE = `${C}/make-whole`;

export const fractionsAddSame: ConceptBundle = {
  concept: {
    key: C,
    category: 'fractions',
    title: 'Adding fractions with the same denominator',
    language: 'en',
    gradeBand: '4-5',
    dependsOn: ['fractions-unit'],
    summary: 'Adding slices of the same size: add the top numbers, keep the bottom number.',
  },
  skills: [
    {
      key: ADD,
      concept: C,
      position: 1,
      title: 'Add the top numbers',
      kind: 'compute',
      steps: [
        step('\\text{same bottom number?}', 'Check that the bottom numbers are the same.'),
        step('\\frac{a}{n} + \\frac{b}{n} = \\frac{a + b}{n}', 'Add the top numbers.'),
        step('\\text{keep } n', 'Keep the bottom number. The slices stay the same size.'),
      ],
      keyStepIndex: 2,
      commonMistake: 'Adds the bottom numbers too: 1/5 + 2/5 = 3/10.',
      tutorNote: 'Say it with words: one fifth plus two fifths, like one apple plus two apples. The fifths stay fifths.',
    },
    {
      key: WHOLE,
      concept: C,
      position: 2,
      title: 'Fill up to one whole',
      kind: 'compute',
      steps: [
        step('\\frac{n}{n} = 1', 'All the parts together make one whole.'),
        step('n - a', 'The missing parts are the bottom number minus the top number.'),
      ],
      keyStepIndex: 0,
      commonMistake: 'Thinks a whole is 1/n, or that 2/5 + 3/5 = 5/10 is one half.',
      tutorNote: 'Draw the bar: shade the parts you have and count the empty ones.',
    },
  ],
  explanations: [
    {
      id: `${C}/intuition`,
      concept: C,
      skill: '',
      kind: 'intuition',
      say:
        'One fifth plus two fifths is like one slice plus two slices of the same pizza. That is three slices. ' +
        'The slices are still fifths.',
      boardItems: [
        { kind: 'visual', content: { visual: 'fraction_bar', parts: 5, shaded: 1, label: '1/5' } },
        { kind: 'visual', content: { visual: 'fraction_bar', parts: 5, shaded: 3, label: '3/5', caption: 'Plus two more slices' } },
      ],
    },
    {
      id: `${C}/rule`,
      concept: C,
      skill: ADD,
      kind: 'rule',
      say: 'Same bottom number: add the top numbers and keep the bottom number.',
      boardItems: [{ kind: 'equation', content: { latex: '\\frac{a}{n} + \\frac{b}{n} = \\frac{a + b}{n}' } }],
    },
    {
      id: `${C}/misconception`,
      concept: C,
      skill: ADD,
      kind: 'misconception',
      say:
        'If you add the bottoms too, one fifth plus two fifths becomes three tenths. ' +
        'But tenths are smaller slices, so you would end up with less pizza than you started with!',
      boardItems: [
        { kind: 'equation', content: { latex: '\\frac{1}{5} + \\frac{2}{5} \\neq \\frac{3}{10}' } },
        { kind: 'visual', content: { visual: 'fraction_bar', parts: 10, shaded: 3, label: '3/10', caption: 'Three tenths: less than three fifths' } },
      ],
    },
  ],
  tasks: [
    ...skillTasks(ADD, {
      worked: {
        difficulty: 1,
        show: '\\frac{1}{5} + \\frac{2}{5}',
        say: 'What is one fifth plus two fifths?',
        answer: frac('3/5'),
        steps: [
          tstep('1 + 2 = 3', 'One slice plus two slices is three slices.', { expected: '3', hint: 'How many slices do we have together?' }),
          tstep('\\frac{1}{5} + \\frac{2}{5} = \\frac{1 + 2}{5} = \\frac{3}{5}', 'The slices are still fifths. Three fifths.', {
            expected: '3/5',
            hint: 'Did the size of the slices change?',
          }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Find the mistake: } \\frac{1}{5} + \\frac{2}{5}',
        say: 'Someone added one fifth and two fifths and got three tenths. Can you find the mistake?',
        answer: frac('3/5'),
        wrongStepIndex: 1,
        steps: [
          tstep('1 + 2 = 3', 'One plus two is three.', { expected: '3' }),
          tstep('\\frac{1}{5} + \\frac{2}{5} = \\frac{3}{10}', 'Five plus five is ten. So it is three tenths.', {
            expected: '3/5',
            hint: 'Did the slices get smaller when we put them together?',
          }),
        ],
      },
      gap: {
        difficulty: 1,
        show: '\\frac{2}{7} + \\frac{3}{7} = \\frac{\\square}{7}',
        say: 'Two sevenths plus three sevenths is how many sevenths?',
        answer: num('5'),
        steps: [tstep('2 + 3 = 5', 'Two slices plus three slices is five slices.', { expected: '5', hint: 'Add the top numbers.' })],
      },
      solo: [
        {
          difficulty: 1,
          show: '\\frac{3}{8} + \\frac{4}{8}',
          say: 'What is three eighths plus four eighths?',
          answer: frac('7/8'),
          steps: [
            tstep('3 + 4 = 7', 'Three plus four is seven.', { expected: '7', hint: 'Add the top numbers.' }),
            tstep('\\frac{3}{8} + \\frac{4}{8} = \\frac{7}{8}', 'Seven eighths.', { expected: '7/8', hint: 'What happens to the bottom number?' }),
          ],
        },
        {
          difficulty: 2,
          show: '\\frac{2}{9} + \\frac{5}{9}',
          say: 'What is two ninths plus five ninths?',
          answer: frac('7/9'),
          steps: [
            tstep('2 + 5 = 7', 'Two plus five is seven.', { expected: '7', hint: 'Add the top numbers.' }),
            tstep('\\frac{2}{9} + \\frac{5}{9} = \\frac{7}{9}', 'Seven ninths.', { expected: '7/9', hint: 'What happens to the bottom number?' }),
          ],
        },
      ],
    }),
    ...skillTasks(WHOLE, {
      worked: {
        difficulty: 1,
        show: '\\frac{3}{4} + \\frac{\\square}{4} = 1',
        say: 'Three quarters plus how many quarters make one whole?',
        answer: num('1'),
        steps: [
          tstep('\\frac{4}{4} = 1', 'Four quarters make one whole.', { expected: '1', hint: 'How many quarters make a whole?' }),
          tstep('4 - 3 = 1', 'We have three. One quarter is missing.', { expected: '1' }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Find the mistake: } \\frac{2}{5} + \\frac{3}{5}',
        say: 'Someone added two fifths and three fifths and got five tenths, one half. Can you find the mistake?',
        answer: frac('5/5'),
        wrongStepIndex: 1,
        steps: [
          tstep('2 + 3 = 5', 'Two plus three is five.', { expected: '5' }),
          tstep('\\frac{2}{5} + \\frac{3}{5} = \\frac{5}{10}', 'Five plus five is ten. So it is five tenths.', {
            expected: '5/5',
            hint: 'Five fifths: how much pizza is that?',
          }),
        ],
      },
      gap: {
        difficulty: 1,
        show: '\\frac{5}{8} + \\frac{\\square}{8} = 1',
        say: 'Five eighths plus how many eighths make one whole?',
        answer: num('3'),
        steps: [tstep('8 - 5 = 3', 'A whole is eight eighths. Eight minus five is three.', { expected: '3', hint: 'How many eighths make a whole?' })],
      },
      solo: [
        {
          difficulty: 1,
          show: '\\frac{1}{3} + \\frac{\\square}{3} = 1',
          say: 'One third plus how many thirds make one whole?',
          answer: num('2'),
          steps: [tstep('3 - 1 = 2', 'A whole is three thirds. Three minus one is two.', { expected: '2', hint: 'How many thirds make a whole?' })],
        },
        {
          difficulty: 2,
          show: '\\frac{4}{6} + \\frac{2}{6}',
          say: 'What is four sixths plus two sixths?',
          answer: num('1'),
          steps: [
            tstep('4 + 2 = 6', 'Four plus two is six.', { expected: '6', hint: 'Add the top numbers.' }),
            tstep('\\frac{4}{6} + \\frac{2}{6} = \\frac{6}{6} = 1', 'Six sixths is one whole.', { expected: '1', hint: 'Six sixths: how much is that?' }),
          ],
        },
      ],
    }),
  ],
};
