// fractions-expand: the full example from the spec ("Content library"), simplified from the
// topic file "Bruch erweitern".
import { type ConceptBundle, step, tstep, frac, num, choice, text, skillTasks } from './helpers';

const C = 'fractions-expand';
const GIVEN = `${C}/given-factor`;
const TARGET = `${C}/target-denominator`;
const WHY = `${C}/why-same`;

export const fractionsExpand: ConceptBundle = {
  concept: {
    key: C,
    category: 'fractions',
    title: 'Expanding fractions',
    language: 'en',
    gradeBand: '5-6',
    dependsOn: ['fractions-unit', 'multiplication-groups'],
    summary: 'Multiply top and bottom by the same number; the amount stays the same.',
  },
  skills: [
    {
      key: GIVEN,
      concept: C,
      position: 1,
      title: 'Expand by a given number',
      kind: 'compute',
      steps: [
        step('\\frac{a}{b} = \\frac{a \\cdot k}{b \\cdot k}', 'Multiply the top and the bottom by the same number k.'),
        step('a \\cdot k', 'First the top number times k.'),
        step('b \\cdot k', 'Then the bottom number times k.'),
      ],
      keyStepIndex: 2,
      commonMistake: 'Multiplies only the top number and keeps the bottom: 3/5 by 4 becomes 12/5.',
      tutorNote: 'Before the bottom step ask what happens to the size of the slices. Link back to cutting every slice into k smaller slices.',
    },
    {
      key: TARGET,
      concept: C,
      position: 2,
      title: 'Expand to a target denominator',
      kind: 'compute',
      steps: [
        step('k = \\text{target} \\div b', 'Find k: the new bottom number divided by the old bottom number.'),
        step('a \\cdot k', 'Multiply the top number by k.'),
        step('\\frac{a \\cdot k}{\\text{target}}', 'Write the new top number over the new bottom number.'),
      ],
      keyStepIndex: 0,
      commonMistake: 'Divides the wrong way round (old bottom divided by new bottom), guesses k, or writes k itself as the new top.',
      tutorNote: 'Ask how many times the old bottom number fits into the new one. Let the student check k by multiplying back.',
    },
    {
      key: WHY,
      concept: C,
      position: 3,
      title: 'Explain why the amount stays the same',
      kind: 'explain',
      steps: [
        step('\\frac{a}{b} \\cdot \\frac{k}{k}', 'Expanding means multiplying by k over k.'),
        step('\\frac{k}{k} = 1', 'k over k is one whole.'),
        step('\\frac{a}{b} \\cdot 1 = \\frac{a}{b}', 'Multiplying by one changes nothing. The amount stays the same.'),
      ],
      keyStepIndex: 2,
      commonMistake: 'Describes the steps ("times top and bottom") but not why the amount stays the same.',
      tutorNote: 'Use the pizza: more cuts, same pizza. Ask: did we add any pizza?',
    },
  ],
  explanations: [
    {
      id: `${C}/intuition`,
      concept: C,
      skill: '',
      kind: 'intuition',
      say:
        'Imagine a pizza cut into three big slices. You have two of them. Now cut each slice into four smaller slices. ' +
        'Now the pizza has twelve slices, and you have eight. It is still the same amount of pizza.',
      boardItems: [
        { kind: 'visual', content: { visual: 'fraction_bar', parts: 3, shaded: 2, label: '2/3', caption: '2 of 3 slices' } },
        { kind: 'visual', content: { visual: 'fraction_bar', parts: 12, shaded: 8, label: '8/12', caption: 'Each slice cut into 4: 8 of 12 slices' } },
      ],
    },
    {
      id: `${C}/rule`,
      concept: C,
      skill: GIVEN,
      kind: 'rule',
      say: 'To expand a fraction, multiply the top and the bottom by the same number.',
      boardItems: [{ kind: 'equation', content: { latex: '\\frac{a}{b} = \\frac{a \\cdot k}{b \\cdot k}', caption: 'k is the same number on top and bottom' } }],
    },
    {
      id: `${C}/misconception`,
      concept: C,
      skill: GIVEN,
      kind: 'misconception',
      say:
        'If you multiply only the top, three fifths turns into twelve fifths. That is more than two whole pizzas! ' +
        'Expanding never adds pizza, so the bottom must change too.',
      boardItems: [
        { kind: 'equation', content: { latex: '\\frac{3}{5} \\neq \\frac{12}{5}', caption: 'Only the top changed: way too much pizza' } },
        { kind: 'visual', content: { visual: 'fraction_bar', parts: 5, shaded: 3, label: '3/5' } },
      ],
    },
  ],
  tasks: [
    ...skillTasks(GIVEN, {
      worked: {
        difficulty: 1,
        show: '\\text{Expand } \\frac{3}{5} \\text{ by } 4',
        say: 'Expand three fifths by four.',
        answer: frac('12/20'),
        steps: [
          tstep('\\frac{3}{5} = \\frac{3 \\cdot 4}{5 \\cdot 4}', 'We multiply the top and the bottom by four.', { hint: 'What do we multiply by?' }),
          tstep('3 \\cdot 4 = 12', 'Three times four is twelve. That is the new top.', { expected: '12', hint: 'What is three times four?' }),
          tstep('\\frac{3}{5} = \\frac{12}{5 \\cdot 4} = \\frac{12}{20}', 'Five times four is twenty. So three fifths is twelve twentieths.', {
            expected: '12/20',
            hint: 'What do we do with the bottom number?',
          }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Find the mistake: expand } \\frac{2}{3} \\text{ by } 4',
        say: 'Someone expanded two thirds by four. Can you find the mistake?',
        answer: frac('8/12'),
        wrongStepIndex: 2,
        steps: [
          tstep('k = 4', 'We expand by four.'),
          tstep('2 \\cdot 4 = 8', 'Two times four is eight.', { expected: '8' }),
          tstep('\\frac{2}{3} = \\frac{8}{3}', 'So two thirds is eight thirds.', { expected: '8/12', hint: 'What happened to the bottom number?' }),
        ],
      },
      gap: {
        difficulty: 1,
        show: '\\frac{1}{2} = \\frac{\\square}{6}',
        say: 'One half is how many sixths?',
        answer: num('3'),
        steps: [
          tstep('6 \\div 2 = 3', 'Six divided by two is three. So we expand by three.', { expected: '3', hint: 'Two times what is six?' }),
          tstep('1 \\cdot 3 = 3', 'One times three is three.', { expected: '3', hint: 'What is one times three?' }),
        ],
      },
      solo: [
        {
          difficulty: 1,
          show: '\\text{Expand } \\frac{1}{2} \\text{ by } 3',
          say: 'Expand one half by three.',
          answer: frac('3/6'),
          steps: [
            tstep('1 \\cdot 3 = 3', 'One times three is three.', { expected: '3', hint: 'What is the top number times three?' }),
            tstep('\\frac{1}{2} = \\frac{3}{2 \\cdot 3} = \\frac{3}{6}', 'Two times three is six. So one half is three sixths.', {
              expected: '3/6',
              hint: 'What do we do with the bottom number?',
            }),
          ],
        },
        {
          difficulty: 2,
          show: '\\text{Expand } \\frac{3}{4} \\text{ by } 2',
          say: 'Expand three quarters by two.',
          answer: frac('6/8'),
          steps: [
            tstep('3 \\cdot 2 = 6', 'Three times two is six.', { expected: '6', hint: 'What is three times two?' }),
            tstep('\\frac{3}{4} = \\frac{6}{4 \\cdot 2} = \\frac{6}{8}', 'Four times two is eight. So three quarters is six eighths.', {
              expected: '6/8',
              hint: 'And the bottom number?',
            }),
          ],
        },
      ],
    }),
    ...skillTasks(TARGET, {
      worked: {
        difficulty: 2,
        show: '\\text{Expand } \\frac{2}{3} \\text{ to the denominator } 12',
        say: 'Expand two thirds so the bottom number is twelve.',
        answer: frac('8/12'),
        steps: [
          tstep('12 \\div 3 = 4', 'Twelve divided by three is four. So k is four.', { expected: '4', hint: 'How many times does three fit into twelve?' }),
          tstep('2 \\cdot 4 = 8', 'Two times four is eight.', { expected: '8', hint: 'What is the top number times four?' }),
          tstep('\\frac{2}{3} = \\frac{8}{12}', 'So two thirds is eight twelfths.', { expected: '8/12' }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Find the mistake: expand } \\frac{3}{4} \\text{ to the denominator } 20',
        say: 'Someone expanded three quarters so the bottom is twenty. Can you find the mistake?',
        answer: frac('15/20'),
        wrongStepIndex: 1,
        steps: [
          tstep('20 \\div 4 = 5', 'Twenty divided by four is five. So k is five.', { expected: '5' }),
          tstep('\\frac{3}{4} = \\frac{5}{20}', 'So the new top is five. Three quarters is five twentieths.', {
            expected: '15/20',
            hint: 'Did we multiply the top number by k?',
          }),
        ],
      },
      gap: {
        difficulty: 2,
        show: '\\frac{3}{5} = \\frac{\\square}{10}',
        say: 'Three fifths is how many tenths?',
        answer: num('6'),
        steps: [
          tstep('10 \\div 5 = 2', 'Ten divided by five is two. So k is two.', { expected: '2', hint: 'Five times what is ten?' }),
          tstep('3 \\cdot 2 = 6', 'Three times two is six.', { expected: '6', hint: 'What is three times two?' }),
        ],
      },
      solo: [
        {
          difficulty: 2,
          show: '\\text{Expand } \\frac{2}{5} \\text{ to the denominator } 20',
          say: 'Expand two fifths so the bottom number is twenty.',
          answer: frac('8/20'),
          steps: [
            tstep('20 \\div 5 = 4', 'Twenty divided by five is four.', { expected: '4', hint: 'How many times does five fit into twenty?' }),
            tstep('2 \\cdot 4 = 8', 'Two times four is eight.', { expected: '8', hint: 'What is the top number times four?' }),
            tstep('\\frac{2}{5} = \\frac{8}{20}', 'So two fifths is eight twentieths.', { expected: '8/20' }),
          ],
        },
        {
          difficulty: 3,
          show: '\\text{Expand } \\frac{3}{4} \\text{ to the denominator } 12',
          say: 'Expand three quarters so the bottom number is twelve.',
          answer: frac('9/12'),
          steps: [
            tstep('12 \\div 4 = 3', 'Twelve divided by four is three.', { expected: '3', hint: 'How many times does four fit into twelve?' }),
            tstep('3 \\cdot 3 = 9', 'Three times three is nine.', { expected: '9', hint: 'What is the top number times three?' }),
            tstep('\\frac{3}{4} = \\frac{9}{12}', 'So three quarters is nine twelfths.', { expected: '9/12' }),
          ],
        },
      ],
    }),
    ...skillTasks(WHY, {
      worked: {
        difficulty: 2,
        show: '\\text{Why is } \\frac{2}{3} \\text{ the same amount as } \\frac{4}{6}\\text{?}',
        say: 'Why is two thirds the same amount as four sixths?',
        answer: text('multiplying by one changes nothing'),
        steps: [
          tstep('\\frac{2}{3} \\cdot \\frac{2}{2} = \\frac{4}{6}', 'We expanded by two. That means times two over two.'),
          tstep('\\frac{2}{2} = 1', 'Two over two is one whole.', { expected: '1', hint: 'What is two halves?' }),
          tstep('\\frac{2}{3} \\cdot 1 = \\frac{2}{3}', 'Times one changes nothing. So the amount stays the same.', { hint: 'What happens when you multiply by one?' }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Someone says } \\frac{4}{6} \\text{ is more than } \\frac{2}{3} \\text{ because the numbers are bigger. Fix it.}',
        say: 'Someone says four sixths is more than two thirds, because the numbers are bigger. Is that right?',
        answer: choice('='),
        wrongStepIndex: 1,
        steps: [
          tstep('\\frac{2}{3} = \\frac{2 \\cdot 2}{3 \\cdot 2} = \\frac{4}{6}', 'Two thirds expanded by two is four sixths.', { expected: '4/6' }),
          tstep('\\frac{4}{6} > \\frac{2}{3}', 'So four sixths is more than two thirds.', { expected: '=', hint: 'Did we add any pizza when we cut the slices smaller?' }),
        ],
      },
      gap: {
        difficulty: 1,
        show: '\\frac{3}{4} \\cdot \\frac{5}{5} = \\frac{3}{4} \\cdot \\square',
        say: 'Three quarters times five fifths is three quarters times what?',
        answer: num('1'),
        steps: [tstep('\\frac{5}{5} = 1', 'Five fifths is one whole.', { expected: '1', hint: 'How many fifths make a whole?' })],
      },
      solo: [
        {
          difficulty: 1,
          show: '\\text{Is } \\frac{3}{5} \\text{ the same amount as } \\frac{6}{10}\\text{? Yes or no?}',
          say: 'Is three fifths the same amount as six tenths? Yes or no?',
          answer: choice('yes'),
          steps: [
            tstep('\\frac{3}{5} \\cdot \\frac{2}{2} = \\frac{6}{10}', 'Three fifths expanded by two is six tenths.', { expected: '6/10', hint: 'What do we multiply by?' }),
            tstep('\\frac{2}{2} = 1', 'Two over two is one, so the amount stays the same.', { expected: '1' }),
          ],
        },
        {
          difficulty: 2,
          show: '\\frac{1}{4} \\square \\frac{3}{12}',
          say: 'Is one quarter smaller than, bigger than, or equal to three twelfths?',
          answer: choice('='),
          steps: [
            tstep('\\frac{1}{4} = \\frac{1 \\cdot 3}{4 \\cdot 3} = \\frac{3}{12}', 'One quarter expanded by three is three twelfths. They are equal.', {
              expected: '=',
              hint: 'Can you expand one quarter so the bottom is twelve?',
            }),
          ],
        },
      ],
    }),
  ],
};
