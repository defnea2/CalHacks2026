import { type ConceptBundle, step, tstep, num, skillTasks } from './helpers';

const C = 'place-value';
const READ = `${C}/digit-value`;
const BUILD = `${C}/compose`;

export const placeValue: ConceptBundle = {
  concept: {
    key: C,
    category: 'numbers',
    title: 'Place value',
    language: 'en',
    gradeBand: '2-3',
    dependsOn: [],
    summary: 'The place of a digit says what it is worth: ones, tens, hundreds. A zero keeps a place empty.',
  },
  skills: [
    {
      key: READ,
      concept: C,
      position: 1,
      title: 'Value of a digit',
      kind: 'compute',
      steps: [
        step('\\text{hundreds} \\mid \\text{tens} \\mid \\text{ones}', 'Put the number in a chart: hundreds, tens, ones.'),
        step('h \\cdot 100 + t \\cdot 10 + o', 'Each place is worth ten times the place to its right.'),
        step('0 \\text{ tens} = \\text{empty place}', 'A zero means the place is empty. It still keeps its spot.'),
      ],
      keyStepIndex: 2,
      commonMistake: 'Ignores the zero and reads 305 as thirty-five.',
      tutorNote: 'Use bundles of ten sticks. Ask which place each digit sits in before asking what it is worth.',
    },
    {
      key: BUILD,
      concept: C,
      position: 2,
      title: 'Build a number from hundreds, tens and ones',
      kind: 'compute',
      steps: [
        step('\\text{hundreds} \\cdot 100', 'Hundreds times one hundred.'),
        step('\\text{tens} \\cdot 10', 'Tens times ten. No tens means a zero in the tens place.'),
        step('\\text{add the ones}', 'Add the ones.'),
      ],
      keyStepIndex: 1,
      commonMistake: 'Writes 3 hundreds and 5 ones as 35, leaving out the zero for the empty tens place.',
      tutorNote: 'Draw three boxes for hundreds, tens and ones. Every box needs a digit, even if it is zero.',
    },
  ],
  explanations: [
    {
      id: `${C}/intuition`,
      concept: C,
      skill: '',
      kind: 'intuition',
      say:
        'Ten sticks tied together make one bundle of ten. Ten bundles of ten make one hundred. ' +
        'Three hundred five is three hundreds, no bundles of ten, and five single sticks.',
      boardItems: [
        { kind: 'visual', content: { visual: 'groups', groups: 3, perGroup: 10, item: '|', caption: '3 bundles of ten = 30' } },
        { kind: 'visual', content: { visual: 'area_grid', rows: 10, cols: 10, shaded: 100, caption: 'Ten tens make one hundred' } },
        { kind: 'equation', content: { latex: '305 = 300 + 0 + 5' } },
      ],
    },
    {
      id: `${C}/rule`,
      concept: C,
      skill: READ,
      kind: 'rule',
      say: 'Each place is worth ten times the place to its right: ones, then tens, then hundreds.',
      boardItems: [{ kind: 'equation', content: { latex: '352 = 3 \\cdot 100 + 5 \\cdot 10 + 2 \\cdot 1' } }],
    },
    {
      id: `${C}/misconception`,
      concept: C,
      skill: READ,
      kind: 'misconception',
      say: 'The zero in three hundred five is not nothing. It keeps the tens place empty, so the three stays in the hundreds.',
      boardItems: [
        { kind: 'equation', content: { latex: '305 \\neq 35', caption: 'The zero holds the tens place' } },
        { kind: 'text', content: { text: 'Zero tens: the tens place is empty, but it is still there.' } },
      ],
    },
  ],
  tasks: [
    ...skillTasks(READ, {
      worked: {
        difficulty: 1,
        show: '\\text{What is the digit 5 worth in } 352\\text{?}',
        say: 'What is the five worth in three hundred fifty-two?',
        answer: num('50'),
        steps: [
          tstep('352 = 300 + 50 + 2', 'Three hundred fifty-two is three hundred plus fifty plus two.'),
          tstep('5 \\cdot 10 = 50', 'The five is in the tens place. Five tens are fifty.', { expected: '50', hint: 'Which place is the five in?' }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Find the mistake: what is the 3 worth in } 305\\text{?}',
        say: 'Someone said the three in three hundred five is worth thirty. Can you find the mistake?',
        answer: num('300'),
        wrongStepIndex: 1,
        steps: [
          tstep('305 = 300 + 0 + 5', 'Three hundred five is three hundred plus zero plus five.'),
          tstep('3 \\cdot 100 = 30', 'So the three is worth thirty.', { expected: '300', hint: 'Which place is the three in?' }),
        ],
      },
      gap: {
        difficulty: 1,
        show: '305 = 3 \\cdot 100 + \\square \\cdot 10 + 5',
        say: 'Three hundred five is three hundreds, how many tens, and five ones?',
        answer: num('0'),
        steps: [tstep('3 \\cdot 100 + 5 = 305', 'Three hundred plus five is already three hundred five.', { expected: '305', hint: 'What is left for the tens?' })],
      },
      solo: [
        {
          difficulty: 1,
          show: '\\text{What is the digit 7 worth in } 472\\text{?}',
          say: 'What is the seven worth in four hundred seventy-two?',
          answer: num('70'),
          steps: [
            tstep('472 = 400 + 70 + 2', 'Four hundred seventy-two is four hundred plus seventy plus two.'),
            tstep('7 \\cdot 10 = 70', 'Seven tens are seventy.', { expected: '70', hint: 'Which place is the seven in?' }),
          ],
        },
        {
          difficulty: 2,
          show: '\\text{What is the digit 6 worth in } 608\\text{?}',
          say: 'What is the six worth in six hundred eight?',
          answer: num('600'),
          steps: [
            tstep('608 = 600 + 0 + 8', 'Six hundred eight is six hundred plus zero plus eight.'),
            tstep('6 \\cdot 100 = 600', 'Six hundreds are six hundred.', { expected: '600', hint: 'Which place is the six in?' }),
          ],
        },
      ],
    }),
    ...skillTasks(BUILD, {
      worked: {
        difficulty: 1,
        show: '\\text{Write the number: 4 hundreds, 2 tens, 7 ones}',
        say: 'Write the number with four hundreds, two tens and seven ones.',
        answer: num('427'),
        steps: [
          tstep('4 \\cdot 100 = 400', 'Four hundreds are four hundred.', { expected: '400' }),
          tstep('2 \\cdot 10 = 20', 'Two tens are twenty.', { expected: '20' }),
          tstep('400 + 20 + 7 = 427', 'Four hundred plus twenty plus seven is four hundred twenty-seven.', { expected: '427' }),
        ],
      },
      repair: {
        difficulty: 2,
        show: '\\text{Find the mistake: 3 hundreds, 0 tens, 5 ones}',
        say: 'Someone wrote three hundreds and five ones as thirty-five. Can you find the mistake?',
        answer: num('305'),
        wrongStepIndex: 2,
        steps: [
          tstep('3 \\cdot 100 = 300', 'Three hundreds are three hundred.', { expected: '300' }),
          tstep('0 \\cdot 10 = 0', 'There are no tens. Zero tens are zero.', { expected: '0' }),
          tstep('300 + 0 + 5 = 35', 'Three hundred plus zero plus five is thirty-five.', { expected: '305', hint: 'Where did the hundreds go?' }),
        ],
      },
      gap: {
        difficulty: 1,
        show: '6 \\cdot 100 + 0 \\cdot 10 + 9 = \\square',
        say: 'Six hundreds, zero tens and nine ones make what number?',
        answer: num('609'),
        steps: [
          tstep('6 \\cdot 100 = 600', 'Six hundreds are six hundred.', { expected: '600' }),
          tstep('600 + 0 + 9 = 609', 'Six hundred plus nine is six hundred nine.', { expected: '609', hint: 'What digit goes in the tens place?' }),
        ],
      },
      solo: [
        {
          difficulty: 1,
          show: '\\text{Write the number: 2 hundreds, 0 tens, 8 ones}',
          say: 'Write the number with two hundreds, zero tens and eight ones.',
          answer: num('208'),
          steps: [
            tstep('2 \\cdot 100 = 200', 'Two hundreds are two hundred.', { expected: '200' }),
            tstep('200 + 0 + 8 = 208', 'Two hundred plus eight is two hundred eight.', { expected: '208', hint: 'What goes in the tens place?' }),
          ],
        },
        {
          difficulty: 2,
          show: '\\text{Write the number: 5 hundreds, 3 tens, 0 ones}',
          say: 'Write the number with five hundreds, three tens and zero ones.',
          answer: num('530'),
          steps: [
            tstep('5 \\cdot 100 = 500', 'Five hundreds are five hundred.', { expected: '500' }),
            tstep('3 \\cdot 10 = 30', 'Three tens are thirty.', { expected: '30' }),
            tstep('500 + 30 + 0 = 530', 'Five hundred plus thirty is five hundred thirty.', { expected: '530', hint: 'What goes in the ones place?' }),
          ],
        },
      ],
    }),
  ],
};
