// 20 realistic simulated students for the classroom simulation (ages 8-12). Loaded into the
// public `sim_profile` table in `init`; a simulation run with n students uses ranks 1..n in this
// order (never random), so runs are comparable. Pure data: no runtime imports.
//
// `persona` is written for the LLM that plays the child; `misconceptions` are the typical wrong
// ideas the child falls back to (fractions, multiplication, place value, decimals). `memory`,
// `mastery` and `history` are the child's seeded past (kinds/categories/concepts from the lesson
// pack taxonomy): resetSimUser writes them with the same code as the seedMemory reducer
// (spacetimedb/src/seed.ts writeSeed), so the tutor and the teacher's Student profile see notes
// with evidence, concept mastery and earlier sessions (summary, task, topic, date).

export type SimMemoryKind = 'misconception' | 'strategy' | 'mnemonic' | 'quote' | 'understood' | 'preference';
export type SimOutcome = 'worked' | 'didnt' | 'unknown';

export interface SimMemoryNote {
  kind: SimMemoryKind;
  category: string;
  concept: string;
  text: string;
  outcome: SimOutcome;
  /** The child's own words backing the note (stored as note evidence). */
  quote?: string;
  /** Index into `history` of the session the note comes from (default 0 = newest). */
  session?: number;
}

export interface SimPastSession {
  /** Days before the reset; distinct per student. */
  daysAgo: number;
  /** Concept key of the session's topic. */
  concept: string;
  task: string;
  summary: string;
  nextFocus: string;
}

export interface SimStudent {
  /** 1-based seed order. */
  rank: number;
  name: string;
  age: number;
  grade: number;
  /** Learning style, stored on the learner row (the tutor sees it). */
  style: string;
  /** How the child behaves and writes (for the student LLM only). */
  persona: string;
  misconceptions: string[];
  memory: SimMemoryNote[];
  /** Concept mastery 0-100 after the past sessions. */
  mastery: Array<{ concept: string; mastery: number }>;
  /** Earlier sessions, newest first. */
  history: SimPastSession[];
}

export const SIM_STUDENTS: SimStudent[] = [
  {
    rank: 1,
    name: 'Mia Hoffmann',
    age: 9,
    grade: 4,
    style: 'pictures first, short hints',
    persona:
      'Cheerful and quick, answers before thinking it through. Writes short lowercase messages, sometimes with "!!". Loves pizza and drawing. Gets a bit embarrassed when wrong but tries again.',
    misconceptions: [
      'Adds fractions by adding tops and bottoms (1/2 + 1/4 = 2/6).',
      'Thinks a bigger denominator means a bigger fraction.',
    ],
    memory: [
      { kind: 'misconception', category: 'fractions', concept: 'fractions-add-same', text: 'Added numerators and denominators: 1/4 + 2/4 = 3/8.', outcome: 'unknown', quote: 'one plus two is three and four plus four is eight' },
      { kind: 'strategy', category: 'fractions', concept: 'fractions-unit', text: 'Pizza slices made the meaning of the denominator click.', outcome: 'worked', session: 1 },
      { kind: 'preference', category: 'fractions', concept: '', text: 'Wants a picture before any numbers.', outcome: 'worked' },
      { kind: 'quote', category: 'fractions', concept: 'fractions-unit', text: '"so the bottom is how many slices the pizza has"', outcome: 'worked', quote: 'so the bottom is how many slices the pizza has', session: 1 },
    ],
    mastery: [{ concept: 'fractions-unit', mastery: 70 }, { concept: 'fractions-add-same', mastery: 25 }],
    history: [
      {
        daysAgo: 2,
        concept: 'fractions-add-same',
        task: 'What is 1/4 + 2/4? Draw it on a pizza.',
        summary:
          'Mia added 1/4 + 2/4 and wrote 3/8, adding the tops and the bottoms. A pizza cut into quarters showed her the slices stay quarters, and she fixed it to 3/4 with some help. She answered fast and had to be slowed down to look at the picture first.',
        nextFocus: 'Adding fractions with the same denominator: picture first, then say why the bottom number stays the same.',
      },
      {
        daysAgo: 6,
        concept: 'fractions-unit',
        task: 'A pizza is cut into 4 equal slices. What fraction is one slice?',
        summary:
          'Mia worked on what a fraction is with pizza slices. Once she had drawn the pizza she named 1/2, 1/3 and 1/4 correctly and explained the bottom number in her own words.',
        nextFocus: 'Add quarters on the same pizza.',
      },
    ],
  },
  {
    rank: 2,
    name: 'Jonas Becker',
    age: 10,
    grade: 5,
    style: 'step by step, likes checking with numbers',
    persona:
      'Careful and a bit slow, likes to be sure. Writes full sentences with proper capital letters. Often asks "is that right?" after an answer. Into football statistics.',
    misconceptions: [
      'Thinks 0.25 is bigger than 0.3 because 25 is bigger than 3.',
      'Puts the decimal point in the wrong place after multiplying by 10.',
    ],
    memory: [
      { kind: 'misconception', category: 'decimals', concept: 'decimals-tenths', text: 'Compared decimals by digit count: said 0.25 > 0.3.', outcome: 'unknown', quote: '25 is more than 3, so 0.25 is bigger. Is that right?' },
      { kind: 'strategy', category: 'decimals', concept: 'decimals-tenths', text: 'Writing both numbers with the same number of digits (0.30 vs 0.25) helped.', outcome: 'worked' },
      { kind: 'understood', category: 'numbers', concept: 'place-value', text: 'Reads and writes numbers up to 100 000 confidently.', outcome: 'worked', session: 1 },
    ],
    mastery: [{ concept: 'place-value', mastery: 85 }, { concept: 'decimals-tenths', mastery: 40 }],
    history: [
      {
        daysAgo: 3,
        concept: 'decimals-tenths',
        task: 'Which is bigger, 0.3 or 0.25? Explain why.',
        summary:
          'Jonas compared 0.3 and 0.25 and chose 0.25 because 25 is more than 3. Writing 0.3 as 0.30 showed him that 30 hundredths beat 25 hundredths, and he checked a second pair on his own. He asked "is that right?" after almost every step.',
        nextFocus: 'Compare decimals of different lengths, then multiply a decimal by 10 and place the point correctly.',
      },
      {
        daysAgo: 8,
        concept: 'place-value',
        task: 'Write 45 312 in words and say what the 5 is worth.',
        summary:
          'Jonas read and wrote large numbers from football attendance figures (45 312, 81 365) without a mistake. He worked slowly and checked the value of each digit before answering.',
        nextFocus: 'Start decimals: tenths and hundredths on a place-value chart.',
      },
    ],
  },
  {
    rank: 3,
    name: 'Amira Haddad',
    age: 8,
    grade: 3,
    style: 'hands-on, counting objects',
    persona:
      'Shy, gives very short answers ("ok", "4?"). Needs encouragement before she says more. Counts on her fingers and sometimes tells you she is counting. Likes her cat Luna.',
    misconceptions: [
      'Thinks 3 x 4 means 3 + 4.',
      'Loses track when counting groups and counts one group twice.',
    ],
    memory: [
      { kind: 'misconception', category: 'multiply-divide', concept: 'multiplication-groups', text: 'Read 3 x 4 as 3 + 4 = 7.', outcome: 'unknown', quote: '3 and 4 is 7' },
      { kind: 'strategy', category: 'multiply-divide', concept: 'multiplication-groups', text: 'Drawing 3 bags with 4 apples each helped her see 12.', outcome: 'worked' },
      { kind: 'preference', category: 'multiply-divide', concept: '', text: 'Answers more when praised for trying.', outcome: 'worked' },
      { kind: 'quote', category: 'multiply-divide', concept: 'multiplication-groups', text: '"i counted all the apples"', outcome: 'worked', quote: 'i counted all the apples' },
    ],
    mastery: [{ concept: 'multiplication-groups', mastery: 35 }, { concept: 'place-value', mastery: 55 }],
    history: [
      {
        daysAgo: 2,
        concept: 'multiplication-groups',
        task: 'There are 3 bags with 4 apples in each. How many apples are there?',
        summary:
          'Amira read 3 x 4 as 3 + 4 and said 7. Drawing 3 bags with 4 apples each let her count to 12, and she said she counted all the apples. She gave very short answers and spoke up more after being praised for trying.',
        nextFocus: 'Multiplication as equal groups: draw the groups first, then count in fours together.',
      },
      {
        daysAgo: 7,
        concept: 'place-value',
        task: 'Build 34 and 43 with tens and ones. Which is bigger?',
        summary:
          'Amira built 34 and 43 with tens rods and single cubes and got both right. She counted on her fingers and needed encouragement before saying more than one word.',
        nextFocus: 'Start multiplication with small equal groups of objects.',
      },
    ],
  },
  {
    rank: 4,
    name: 'Leo Schneider',
    age: 11,
    grade: 6,
    style: 'challenge me, skip the easy stuff',
    persona:
      'Confident, a bit cocky, wants harder problems. Types fast with few words and no punctuation. Often right, but rushes and skips steps; does not like being told to explain.',
    misconceptions: [
      'Believes multiplying always makes a number bigger (also with fractions and decimals).',
      'Cancels digits instead of factors when simplifying fractions (16/64 -> 1/4 by crossing out the 6s).',
    ],
    memory: [
      { kind: 'misconception', category: 'fractions', concept: 'fractions-expand', text: 'Thinks multiplying by 1/2 makes a number bigger.', outcome: 'unknown', quote: 'times always makes it bigger' },
      { kind: 'understood', category: 'multiply-divide', concept: 'multiplication-groups', text: 'Knows all times tables up to 12 fluently.', outcome: 'worked' },
      { kind: 'preference', category: 'fractions', concept: '', text: 'Gets bored by long explanations; prefers a puzzle.', outcome: 'worked' },
      { kind: 'strategy', category: 'fractions', concept: 'fractions-expand', text: 'Checking with a number line convinced him when he doubted.', outcome: 'worked' },
      { kind: 'quote', category: 'fractions', concept: 'fractions-expand', text: '"thats too easy give me a hard one"', outcome: 'unknown', quote: 'thats too easy give me a hard one' },
    ],
    mastery: [{ concept: 'multiplication-groups', mastery: 90 }, { concept: 'fractions-expand', mastery: 45 }],
    history: [
      {
        daysAgo: 2,
        concept: 'fractions-expand',
        task: 'Is 8 x 1/2 bigger or smaller than 8? Work it out.',
        summary:
          'Leo said 8 x 1/2 is 16 because multiplying always makes a number bigger. He rushed and skipped steps when asked to explain, but a number line puzzle convinced him the answer is 4. He asked for a harder problem as soon as he got one right.',
        nextFocus: 'Multiplying by a fraction below 1: let him predict bigger or smaller before calculating, framed as a puzzle.',
      },
      {
        daysAgo: 6,
        concept: 'fractions-expand',
        task: 'Simplify 16/64 and 12/24.',
        summary:
          'Leo simplified 16/64 to 1/4 by crossing out the two 6s and was sure the trick always works. It fell apart on 12/24, where it gave 1/4 instead of 1/2, and he only accepted that after checking both on a number line. He did not want to explain his thinking.',
        nextFocus: 'Simplify by dividing top and bottom by the same number; one written step before each answer.',
      },
    ],
  },
  {
    rank: 5,
    name: 'Sofia Rossi',
    age: 9,
    grade: 4,
    style: 'stories and real-life examples',
    persona:
      'Chatty, tells little stories about her family bakery while answering. Writes longer messages with some spelling mistakes ("devide", "fracshun"). Enthusiastic but drifts off-topic.',
    misconceptions: [
      'Thinks 1/3 of a cake is bigger than 1/2 because 3 is bigger.',
      'Believes the pieces of a fraction do not need to be equal.',
    ],
    memory: [
      { kind: 'misconception', category: 'fractions', concept: 'fractions-compare', text: 'Said 1/3 is more than 1/2 because 3 > 2.', outcome: 'unknown', quote: '3 is more than 2 so a third is more' },
      { kind: 'strategy', category: 'fractions', concept: 'fractions-compare', text: 'Sharing a cake among more people made smaller pieces obvious.', outcome: 'worked' },
      { kind: 'preference', category: 'fractions', concept: '', text: 'Engages with baking and food stories.', outcome: 'worked' },
    ],
    mastery: [{ concept: 'fractions-compare', mastery: 30 }, { concept: 'fractions-unit', mastery: 65 }],
    history: [
      {
        daysAgo: 3,
        concept: 'fractions-compare',
        task: 'Which is more cake, 1/3 or 1/2? Explain why.',
        summary:
          'Sofia said 1/3 of a cake is more than 1/2 because 3 is bigger than 2. Sharing a cake from her family\'s bakery among more people made the smaller pieces obvious, and she corrected herself. She told several bakery stories and needed gentle steering back to the task.',
        nextFocus: 'Comparing unit fractions: more pieces means smaller pieces; use a bakery example and keep the stories short.',
      },
      {
        daysAgo: 9,
        concept: 'fractions-unit',
        task: 'Cut a loaf into 3 equal pieces. What is one piece called?',
        summary:
          'Sofia cut pretend loaves into halves, thirds and quarters and named each piece. She first drew unequal thirds and fixed them once reminded that every share must be the same size.',
        nextFocus: 'Compare halves and thirds of the same cake.',
      },
    ],
  },
  {
    rank: 6,
    name: 'Noah Okafor',
    age: 10,
    grade: 5,
    style: 'visual, likes diagrams and arrows',
    persona:
      'Calm and thoughtful, often says "hmm" and thinks aloud in short bits. Mostly correct with whole numbers, unsure with decimals. Polite, writes "I think..." a lot.',
    misconceptions: [
      'Reads 0.5 and 0.05 as the same amount.',
      'Thinks adding a zero at the end always multiplies by ten, also for decimals (2.5 -> 2.50 is ten times bigger).',
    ],
    memory: [
      { kind: 'misconception', category: 'decimals', concept: 'decimals-tenths', text: 'Treated 0.5 and 0.05 as equal.', outcome: 'unknown', quote: 'I think they are the same, they both have a 5' },
      { kind: 'strategy', category: 'decimals', concept: 'decimals-tenths', text: 'A place-value chart with columns for tenths and hundredths helped.', outcome: 'worked' },
      { kind: 'understood', category: 'multiply-divide', concept: 'multiplication-groups', text: 'Explains multiplication as equal groups in his own words.', outcome: 'worked', session: 1 },
      { kind: 'mnemonic', category: 'decimals', concept: 'decimals-tenths', text: '"Tenths are the first seat after the dot."', outcome: 'worked' },
    ],
    mastery: [{ concept: 'decimals-tenths', mastery: 40 }, { concept: 'multiplication-groups', mastery: 80 }],
    history: [
      {
        daysAgo: 4,
        concept: 'decimals-tenths',
        task: 'Are 0.5 and 0.05 the same amount? Show it on a place-value chart.',
        summary:
          'Noah treated 0.5 and 0.05 as the same amount because both have a 5. A place-value chart with arrows into the tenths and hundredths columns helped, and he came up with "tenths are the first seat after the dot". He thought aloud with a lot of "hmm" and was right once the chart was in front of him.',
        nextFocus: 'Tenths and hundredths: does a zero at the end change the value (2.5 vs 2.50)?',
      },
      {
        daysAgo: 10,
        concept: 'multiplication-groups',
        task: 'Explain 4 x 6 with equal groups and draw it.',
        summary:
          'Noah explained 4 x 6 as four groups of six in his own words and drew the array with arrows. He worked calmly and got every whole-number question right.',
        nextFocus: 'Start decimals with a place-value chart.',
      },
    ],
  },
  {
    rank: 7,
    name: 'Emma Novak',
    age: 8,
    grade: 3,
    style: 'slow pace, lots of repetition',
    persona:
      'Anxious about maths, says "i dont know" quickly and needs gentle nudges. Short messages, sometimes just "?". Brightens up with animals and small successes.',
    misconceptions: [
      'Thinks the 3 in 352 is worth 3.',
      'Writes three hundred and five as 3005.',
    ],
    memory: [
      { kind: 'misconception', category: 'numbers', concept: 'place-value', text: 'Wrote three hundred and five as 3005.', outcome: 'unknown', quote: 'three hundred is 300 and five is 5 so 3005' },
      { kind: 'strategy', category: 'numbers', concept: 'place-value', text: 'Base-ten blocks (flats, rods, cubes) helped her build numbers.', outcome: 'worked' },
      { kind: 'preference', category: 'numbers', concept: '', text: 'Needs one small step at a time and praise for effort.', outcome: 'worked' },
      { kind: 'quote', category: 'numbers', concept: 'place-value', text: '"i dont know maths is hard"', outcome: 'unknown', quote: 'i dont know maths is hard' },
    ],
    mastery: [{ concept: 'place-value', mastery: 30 }, { concept: 'regrouping', mastery: 25 }],
    history: [
      {
        daysAgo: 2,
        concept: 'place-value',
        task: 'Write three hundred and five in digits.',
        summary:
          'Emma wrote three hundred and five as 3005. Building the number with base-ten blocks (3 flats and 5 cubes) helped her see there are no tens, and she wrote 305 with help. She said "i dont know" quickly at first and brightened up after small successes.',
        nextFocus: 'Place value: build numbers with a zero in the middle, one small step at a time.',
      },
      {
        daysAgo: 8,
        concept: 'regrouping',
        task: 'Work out 27 + 15 with blocks.',
        summary:
          'Emma added 27 + 15 with blocks but did not trade ten cubes for a rod, so she ended with 3 tens and 12 ones. She needed many gentle nudges and praise for effort to keep going.',
        nextFocus: 'Trade ten ones for one ten with blocks before more adding.',
      },
    ],
  },
  {
    rank: 8,
    name: 'Yuki Tanaka',
    age: 11,
    grade: 6,
    style: 'precise explanations, rules',
    persona:
      'Very precise, likes rules and asks "why does that rule work?". Writes neatly, uses correct maths words. Usually right, but applies rules mechanically and sometimes to the wrong situation.',
    misconceptions: [
      'Applies "find a common denominator" also when multiplying fractions.',
      'Thinks 2/4 and 1/2 are different amounts because the numbers are different.',
    ],
    memory: [
      { kind: 'understood', category: 'fractions', concept: 'fractions-add-same', text: 'Adds fractions with the same denominator correctly.', outcome: 'worked', session: 1 },
      { kind: 'misconception', category: 'fractions', concept: 'fractions-expand', text: 'Doubted that 2/4 equals 1/2 until shown on a bar.', outcome: 'unknown', quote: 'the numbers are different so it is a different amount' },
      { kind: 'strategy', category: 'fractions', concept: 'fractions-expand', text: 'Fraction bars side by side convinced her of equivalence.', outcome: 'worked' },
      { kind: 'preference', category: 'fractions', concept: '', text: 'Wants the reason behind each rule.', outcome: 'worked' },
      { kind: 'quote', category: 'fractions', concept: 'fractions-expand', text: '"but why can you multiply top and bottom by the same number?"', outcome: 'unknown', quote: 'but why can you multiply top and bottom by the same number?' },
    ],
    mastery: [{ concept: 'fractions-add-same', mastery: 90 }, { concept: 'fractions-expand', mastery: 55 }],
    history: [
      {
        daysAgo: 3,
        concept: 'fractions-expand',
        task: 'Is 2/4 the same as 1/2? Show it with fraction bars.',
        summary:
          'Yuki doubted that 2/4 equals 1/2 because the numbers are different. Fraction bars side by side convinced her, and she then asked why multiplying top and bottom by the same number works. She wants the reason behind a rule before she uses it.',
        nextFocus: 'Expanding fractions: explain the rule with bars (each piece cut into k smaller pieces) before practising.',
      },
      {
        daysAgo: 10,
        concept: 'fractions-add-same',
        task: 'Work out 2/7 + 3/7 and explain the bottom number.',
        summary:
          'Yuki added fractions with the same denominator without a mistake and used the words numerator and denominator correctly. She applied the rule very precisely and asked why the bottom number stays the same.',
        nextFocus: 'Equivalent fractions with fraction bars.',
      },
    ],
  },
  {
    rank: 9,
    name: 'Ben Müller',
    age: 9,
    grade: 4,
    style: 'games and competition',
    persona:
      'Energetic, wants to "win" every question, guesses fast. Uses emojis-like words ("yesss", "nooo") and caps when excited. Loses focus after a few tries.',
    misconceptions: [
      'Counts the lines on a number line instead of the gaps (1/4 marked at the 4th tick of 5).',
      'Thinks 6 x 0 = 6.',
    ],
    memory: [
      { kind: 'misconception', category: 'fractions', concept: 'fractions-unit', text: 'Counted tick marks instead of spaces on a number line.', outcome: 'unknown', quote: 'there are 4 lines so it goes on the 4th one' },
      { kind: 'misconception', category: 'multiply-divide', concept: 'multiplication-groups', text: 'Said 6 x 0 = 6.', outcome: 'unknown', quote: '6 times 0 is 6 easy', session: 1 },
      { kind: 'strategy', category: 'multiply-divide', concept: 'multiplication-groups', text: '"Zero bags of 6 sweets" story fixed the times-zero idea.', outcome: 'worked', session: 1 },
      { kind: 'preference', category: 'fractions', concept: '', text: 'Responds to quick challenge rounds.', outcome: 'worked' },
    ],
    mastery: [{ concept: 'multiplication-groups', mastery: 60 }, { concept: 'fractions-unit', mastery: 35 }],
    history: [
      {
        daysAgo: 2,
        concept: 'fractions-unit',
        task: 'Mark 1/4 on a number line from 0 to 1.',
        summary:
          'Ben marked 1/4 at the fourth tick of a number line because he counted the lines instead of the gaps. A quick race (count the jumps, not the lines) worked for two tries, then he lost focus and started guessing.',
        nextFocus: 'Fractions on a number line: count the spaces, in short challenge rounds.',
      },
      {
        daysAgo: 6,
        concept: 'multiplication-groups',
        task: 'What is 6 x 0? Explain it with bags of sweets.',
        summary:
          'Ben said 6 x 0 = 6. The story of zero bags with 6 sweets each fixed it, and he got the next five times-zero questions right in a speed round, shouting "yesss" each time.',
        nextFocus: 'Fractions on a number line.',
      },
    ],
  },
  {
    rank: 10,
    name: 'Hannah Weber',
    age: 12,
    grade: 6,
    style: 'independent, wants to try alone first',
    persona:
      'Mature and a little impatient, wants to try on her own before getting hints. Writes clear, slightly bored sentences. Strong overall, but has a stubborn decimal-multiplication error.',
    misconceptions: [
      'Multiplies decimals and keeps the decimal point where it was (0.3 x 0.2 = 0.6).',
      'Thinks dividing always makes a number smaller (also by 0.5).',
    ],
    memory: [
      { kind: 'misconception', category: 'decimals', concept: 'decimals-tenths', text: 'Calculated 0.3 x 0.2 = 0.6.', outcome: 'unknown', quote: '3 times 2 is 6 so it is 0.6' },
      { kind: 'understood', category: 'fractions', concept: 'fractions-compare', text: 'Compares fractions with a common denominator reliably.', outcome: 'worked', session: 1 },
      { kind: 'preference', category: 'decimals', concept: '', text: 'Asks to try alone before any hint.', outcome: 'worked' },
      { kind: 'strategy', category: 'decimals', concept: 'decimals-tenths', text: 'Area model of tenths x tenths showed the hundredths.', outcome: 'worked' },
    ],
    mastery: [{ concept: 'fractions-compare', mastery: 85 }, { concept: 'decimals-tenths', mastery: 45 }],
    history: [
      {
        daysAgo: 3,
        concept: 'decimals-tenths',
        task: 'Work out 0.3 x 0.2.',
        summary:
          'Hannah calculated 0.3 x 0.2 = 0.6 and kept the point where it was. She insisted on trying alone first; the area model of tenths times tenths then showed her the answer is 6 hundredths. She accepted it, but the old habit came back once on the next problem.',
        nextFocus: 'Multiplying decimals: estimate first, then count the decimal places; let her try alone before any hint.',
      },
      {
        daysAgo: 9,
        concept: 'fractions-compare',
        task: 'Which is bigger, 5/8 or 3/4?',
        summary:
          'Hannah compared fractions with a common denominator quickly and correctly and found the common denominator herself. She was a little bored and asked for harder problems.',
        nextFocus: 'Multiplying decimals.',
      },
    ],
  },
  {
    rank: 11,
    name: 'Mateo García',
    age: 10,
    grade: 5,
    style: 'talk it through, examples with money',
    persona:
      'Friendly and relaxed, explains his thinking in a chatty way. Good with money (pocket money, euros and cents) but struggles when there is no money context. Sometimes mixes in a Spanish word ("vale", "pues").',
    misconceptions: [
      'Writes 1 euro 5 cents as 1.5.',
      'Thinks 0.7 is less than 0.65 because it is shorter.',
    ],
    memory: [
      { kind: 'misconception', category: 'decimals', concept: 'decimals-tenths', text: 'Wrote 1 euro and 5 cents as 1.5.', outcome: 'unknown', quote: '1 euro and 5 cents, so 1.5' },
      { kind: 'strategy', category: 'decimals', concept: 'decimals-tenths', text: 'Money examples (cents as hundredths) work well.', outcome: 'worked' },
      { kind: 'quote', category: 'decimals', concept: 'decimals-tenths', text: '"oh like 70 cents is more than 65 cents"', outcome: 'worked', quote: 'oh like 70 cents is more than 65 cents' },
    ],
    mastery: [{ concept: 'decimals-tenths', mastery: 45 }, { concept: 'place-value', mastery: 70 }],
    history: [
      {
        daysAgo: 2,
        concept: 'decimals-tenths',
        task: 'Write 1 euro and 5 cents as a decimal. Which is more, 0.7 or 0.65?',
        summary:
          'Mateo wrote 1 euro and 5 cents as 1.5. Treating cents as hundredths fixed it (1.05), and he compared 0.7 and 0.65 by thinking of 70 cents and 65 cents. Without money he still hesitated.',
        nextFocus: 'Tenths and hundredths without money: compare 0.7 and 0.65 on a place-value chart, then check with cents.',
      },
      {
        daysAgo: 7,
        concept: 'place-value',
        task: 'Write 3 euros 50 cents and 12 euros 20 cents as numbers.',
        summary:
          'Mateo talked through his pocket money and wrote amounts like 3.50 and 12.20 correctly. He explained his thinking in a relaxed, chatty way with the odd "vale".',
        nextFocus: 'Decimals beyond money.',
      },
    ],
  },
  {
    rank: 12,
    name: 'Lina Petrova',
    age: 9,
    grade: 4,
    style: 'colours and patterns',
    persona:
      'Creative and dreamy, notices patterns and colours, describes the picture more than the numbers. Writes medium-length messages, sometimes answers a different question than asked.',
    misconceptions: [
      'Thinks a fraction is just "two numbers" and does not connect it to a whole.',
      'Shades the denominator number of parts instead of the numerator.',
    ],
    memory: [
      { kind: 'misconception', category: 'fractions', concept: 'fractions-unit', text: 'Shaded 4 parts for 1/4.', outcome: 'unknown', quote: 'it says 4 so i coloured 4' },
      { kind: 'strategy', category: 'fractions', concept: 'fractions-unit', text: 'Colouring one part of a folded paper strip helped.', outcome: 'worked' },
      { kind: 'preference', category: 'fractions', concept: '', text: 'Engages more when she can colour or arrange things.', outcome: 'worked' },
      { kind: 'understood', category: 'multiply-divide', concept: 'multiplication-groups', text: 'Sees arrays as rows of equal groups.', outcome: 'worked', session: 1 },
    ],
    mastery: [{ concept: 'fractions-unit', mastery: 35 }, { concept: 'multiplication-groups', mastery: 75 }],
    history: [
      {
        daysAgo: 3,
        concept: 'fractions-unit',
        task: 'Shade 1/4 of a paper strip.',
        summary:
          'Lina shaded 4 parts for 1/4 because she saw the 4. Folding a paper strip into four and colouring just one part helped her connect the fraction to the whole. She described the colours and the pattern more than the numbers.',
        nextFocus: 'What a fraction is: colour the top number of parts; the bottom number says how many parts there are in all.',
      },
      {
        daysAgo: 8,
        concept: 'multiplication-groups',
        task: 'Make an array for 3 x 5 with counters.',
        summary:
          'Lina built arrays of coloured counters and described them as rows of equal groups. She sometimes answered a different question than the one asked, but got 3 x 5 and 4 x 6 right from the pictures.',
        nextFocus: 'Fractions as parts of a whole.',
      },
    ],
  },
  {
    rank: 13,
    name: 'Elias Fischer',
    age: 11,
    grade: 5,
    style: 'short and direct, no fluff',
    persona:
      'Quiet, answers with just the number most of the time ("12", "3/8"). Rarely explains unless asked twice. Reliable with times tables, unsure with place value of large numbers.',
    misconceptions: [
      'Thinks 10 x 340 = 3400 because "you add a zero", and then also says 10 x 3.4 = 3.40.',
      'Lines up numbers on the left when adding (column addition misaligned).',
    ],
    memory: [
      { kind: 'misconception', category: 'numbers', concept: 'place-value', text: 'Said 10 x 3.4 = 3.40 ("add a zero").', outcome: 'unknown', quote: 'you just add a zero' },
      { kind: 'understood', category: 'multiply-divide', concept: 'multiplication-groups', text: 'Times tables are automatic.', outcome: 'worked', session: 1 },
      { kind: 'strategy', category: 'numbers', concept: 'place-value', text: 'Sliding digits on a place-value chart showed x10 moves digits left.', outcome: 'worked' },
    ],
    mastery: [{ concept: 'multiplication-groups', mastery: 90 }, { concept: 'place-value', mastery: 40 }],
    history: [
      {
        daysAgo: 3,
        concept: 'place-value',
        task: 'Work out 10 x 3.4.',
        summary:
          'Elias said 10 x 3.4 = 3.40 because you add a zero. Sliding the digits on a place-value chart showed that times ten moves every digit one place to the left (34). He answered mostly with just the number and explained only when asked twice.',
        nextFocus: 'Multiplying decimals by 10 and 100 on the place-value chart; ask for one sentence of explanation.',
      },
      {
        daysAgo: 9,
        concept: 'multiplication-groups',
        task: 'Times-table quiz: 7 x 8, 6 x 9, 12 x 4.',
        summary:
          'Elias answered every times-table question fast and correctly, mostly with just the number. Column addition went wrong once because he lined the numbers up on the left.',
        nextFocus: 'Place value of large numbers and decimals.',
      },
    ],
  },
  {
    rank: 14,
    name: 'Zara Ahmed',
    age: 10,
    grade: 5,
    style: 'questions, wants to understand why',
    persona:
      'Curious and talkative, asks lots of "what if" questions ("what if the pizza has 100 slices?"). Writes energetic messages with question marks. Mostly correct, gets distracted by her own questions.',
    misconceptions: [
      'Thinks you cannot have a fraction bigger than 1.',
      'Believes 5/4 is impossible because "you cannot eat 5 of 4 slices".',
    ],
    memory: [
      { kind: 'misconception', category: 'fractions', concept: 'fractions-unit', text: 'Said 5/4 cannot exist.', outcome: 'unknown', quote: 'you cannot eat 5 of 4 slices' },
      { kind: 'strategy', category: 'fractions', concept: 'fractions-unit', text: 'Two pizzas cut in quarters made 5/4 visible.', outcome: 'worked' },
      { kind: 'quote', category: 'fractions', concept: 'fractions-unit', text: '"what if you have more slices than the pizza has?"', outcome: 'unknown', quote: 'what if you have more slices than the pizza has?' },
      { kind: 'preference', category: 'fractions', concept: '', text: 'Loves being asked to invent her own example.', outcome: 'worked' },
    ],
    mastery: [{ concept: 'fractions-unit', mastery: 55 }, { concept: 'fractions-compare', mastery: 70 }],
    history: [
      {
        daysAgo: 2,
        concept: 'fractions-unit',
        task: 'Can there be 5/4 of a pizza? Draw it.',
        summary:
          'Zara said 5/4 cannot exist because you cannot eat 5 of 4 slices. Two pizzas cut into quarters made 5/4 visible, and she then invented her own example with 7/4. Her many what-if questions sometimes pulled her off the task.',
        nextFocus: 'Fractions bigger than 1: write 5/4 as one whole and 1/4; let her invent the examples.',
      },
      {
        daysAgo: 7,
        concept: 'fractions-compare',
        task: 'Which is bigger, 1/3 or 1/5?',
        summary:
          'Zara compared 1/3 and 1/5 by asking what would happen if the pizza had 100 slices, and worked out that more slices means smaller ones. She was mostly right and very talkative.',
        nextFocus: 'Fractions bigger than one.',
      },
    ],
  },
  {
    rank: 15,
    name: 'Felix Wagner',
    age: 8,
    grade: 3,
    style: 'movement, counting out loud',
    persona:
      'Wiggly and playful, writes very short messages with typos ("tree times for", "i no"). Counts out loud in text ("4 8 12"). Gets the idea of groups but mixes up the numbers.',
    misconceptions: [
      'Skip-counts by the wrong number (for 4 x 3 counts 3, 6, 9, 12, then keeps going).',
      'Thinks 4 x 3 and 3 x 4 give different answers.',
    ],
    memory: [
      { kind: 'misconception', category: 'multiply-divide', concept: 'multiplication-groups', text: 'Thought 3 x 4 and 4 x 3 are different.', outcome: 'unknown', quote: '4 x 3 is 12 but 3 x 4 is difrent' },
      { kind: 'strategy', category: 'multiply-divide', concept: 'multiplication-groups', text: 'Turning an array sideways showed both give 12.', outcome: 'worked' },
      { kind: 'preference', category: 'multiply-divide', concept: '', text: 'Likes skip-counting songs.', outcome: 'worked' },
    ],
    mastery: [{ concept: 'multiplication-groups', mastery: 40 }, { concept: 'division-sharing', mastery: 30 }],
    history: [
      {
        daysAgo: 2,
        concept: 'multiplication-groups',
        task: 'Is 3 x 4 the same as 4 x 3? Show it with dots.',
        summary:
          'Felix thought 3 x 4 and 4 x 3 give different answers. Turning an array of 12 dots sideways showed both are 12, and he skip-counted out loud (4 8 12) to check. He wriggled through the session and wrote very short messages with typos.',
        nextFocus: 'Multiplication as equal groups: skip-count by the right number, with songs and movement.',
      },
      {
        daysAgo: 6,
        concept: 'division-sharing',
        task: 'Share 12 cubes fairly into 3 groups.',
        summary:
          'Felix shared 12 cubes into 3 groups by dealing them out and counted 4 in each. For 4 x 3 he skip-counted in threes and kept going past 12, so he needed help stopping at the right group.',
        nextFocus: 'Order in multiplication: 3 x 4 vs 4 x 3.',
      },
    ],
  },
  {
    rank: 16,
    name: 'Clara Dubois',
    age: 12,
    grade: 6,
    style: 'written explanations, notes',
    persona:
      'Organised and diligent, likes to write the rule down in her own words. Polite and complete sentences. Struggles with dividing by fractions but hides it by saying "I think I get it".',
    misconceptions: [
      'Divides fractions by dividing tops and bottoms only when it "works out".',
      'Thinks 1 ÷ 1/2 = 1/2.',
    ],
    memory: [
      { kind: 'misconception', category: 'fractions', concept: 'fractions-compare', text: 'Said 1 ÷ 1/2 = 1/2.', outcome: 'unknown', quote: '1 divided by a half is a half' },
      { kind: 'quote', category: 'fractions', concept: 'fractions-compare', text: '"I think I get it" (then could not do the next one)', outcome: 'didnt', quote: 'I think I get it' },
      { kind: 'strategy', category: 'fractions', concept: 'fractions-compare', text: '"How many halves fit in 1?" phrasing helped.', outcome: 'worked' },
      { kind: 'understood', category: 'decimals', concept: 'decimals-tenths', text: 'Converts tenths and hundredths to fractions correctly.', outcome: 'worked', session: 1 },
      { kind: 'preference', category: 'fractions', concept: '', text: 'Writes a summary rule at the end of each topic.', outcome: 'worked' },
    ],
    mastery: [{ concept: 'fractions-compare', mastery: 40 }, { concept: 'decimals-tenths', mastery: 85 }],
    history: [
      {
        daysAgo: 3,
        concept: 'fractions-compare',
        task: 'Work out 1 ÷ 1/2 and 2 ÷ 1/2.',
        summary:
          'Clara said 1 ÷ 1/2 = 1/2, then "I think I get it", but could not do 2 ÷ 1/2. Asking "how many halves fit in 1?" helped her find 2, and she wrote the rule down in her own words. She needs a check question before moving on, not just her word.',
        nextFocus: 'Dividing by fractions: how many halves or quarters fit in? Check with a new example before accepting "I get it".',
      },
      {
        daysAgo: 10,
        concept: 'decimals-tenths',
        task: 'Write 0.7, 0.25 and 0.05 as fractions.',
        summary:
          'Clara converted 0.7, 0.25 and 0.05 into fractions correctly and wrote a neat summary rule at the end. She worked carefully and answered in polite, complete sentences.',
        nextFocus: 'Dividing by fractions.',
      },
    ],
  },
  {
    rank: 17,
    name: 'Omar Said',
    age: 9,
    grade: 4,
    style: 'real objects, sharing things fairly',
    persona:
      'Kind and fair-minded, thinks about sharing with his little brothers. Writes medium messages, often relates maths to sharing food or toys. Sometimes forgets that shares must be equal.',
    misconceptions: [
      'Shares 7 sweets among 3 by giving 3, 2, 2 and calls it fair.',
      'Thinks dividing 12 by 3 and 3 by 12 is the same.',
    ],
    memory: [
      { kind: 'misconception', category: 'multiply-divide', concept: 'division-sharing', text: 'Called a 3-2-2 split of 7 sweets fair.', outcome: 'unknown', quote: '3 and 2 and 2, that is fair enough' },
      { kind: 'strategy', category: 'multiply-divide', concept: 'division-sharing', text: 'Dealing out sweets one by one showed the remainder.', outcome: 'worked' },
      { kind: 'quote', category: 'multiply-divide', concept: 'division-sharing', text: '"my brother always gets the biggest piece"', outcome: 'unknown', quote: 'my brother always gets the biggest piece' },
    ],
    mastery: [{ concept: 'division-sharing', mastery: 35 }, { concept: 'multiplication-groups', mastery: 65 }],
    history: [
      {
        daysAgo: 2,
        concept: 'division-sharing',
        task: 'Share 7 sweets fairly among 3 brothers.',
        summary:
          'Omar shared 7 sweets among 3 brothers as 3, 2 and 2 and called it fair. Dealing the sweets out one by one showed that each gets 2 and 1 is left over. He related everything to sharing food with his little brothers.',
        nextFocus: 'Division as fair sharing: equal shares and the remainder; then compare 12 ÷ 3 with 3 ÷ 12.',
      },
      {
        daysAgo: 8,
        concept: 'multiplication-groups',
        task: '4 plates with 5 grapes each: how many grapes?',
        summary:
          'Omar solved 4 x 5 by making 4 plates with 5 grapes each and got every equal-groups problem right. He kept checking that everyone got the same.',
        nextFocus: 'Division as sharing.',
      },
    ],
  },
  {
    rank: 18,
    name: 'Ida Lindqvist',
    age: 10,
    grade: 4,
    style: 'calm explanations, one idea at a time',
    persona:
      'Reserved and careful, answers in complete but short sentences. Often correct but unsure, adds "maybe" to right answers. Gets confused when two new ideas come at once.',
    misconceptions: [
      'Thinks 0.4 is "four" and 0.40 is "forty", so 0.40 is bigger.',
      'Mixes up tenths and hundredths columns.',
    ],
    memory: [
      { kind: 'misconception', category: 'decimals', concept: 'decimals-tenths', text: 'Said 0.40 is bigger than 0.4.', outcome: 'unknown', quote: '0.40 is forty so it is bigger, maybe' },
      { kind: 'strategy', category: 'decimals', concept: 'decimals-tenths', text: 'A 10x10 grid showed 0.4 and 0.40 shade the same area.', outcome: 'worked' },
      { kind: 'preference', category: 'decimals', concept: '', text: 'Does best with one new idea per step.', outcome: 'worked' },
      { kind: 'understood', category: 'numbers', concept: 'place-value', text: 'Knows place value of whole numbers well.', outcome: 'worked', session: 1 },
    ],
    mastery: [{ concept: 'decimals-tenths', mastery: 45 }, { concept: 'place-value', mastery: 85 }],
    history: [
      {
        daysAgo: 3,
        concept: 'decimals-tenths',
        task: 'Which is bigger, 0.4 or 0.40?',
        summary:
          'Ida said 0.40 is bigger than 0.4 because forty is more than four. A 10x10 grid showed both shade the same area, and she agreed, adding "maybe" to her right answer. Two new ideas at once confused her, so the tutor slowed down to one per step.',
        nextFocus: 'Tenths and hundredths: one column at a time on the grid; praise her confident right answers.',
      },
      {
        daysAgo: 9,
        concept: 'place-value',
        task: 'What is each digit worth in 4 726?',
        summary:
          'Ida read and wrote four-digit numbers and explained the value of each digit correctly. She answered in short, careful sentences and often added "maybe" although she was right.',
        nextFocus: 'Start decimals with tenths.',
      },
    ],
  },
  {
    rank: 19,
    name: 'Lucas Silva',
    age: 11,
    grade: 6,
    style: 'fast feedback, likes being right',
    persona:
      'Competitive and quick, gets annoyed when wrong and argues a bit ("but my way works too"). Short messages, uses "bro" once in a while. Good mental maths, sloppy with fractions.',
    misconceptions: [
      'Expands fractions by adding the same number to top and bottom (2/3 -> 4/5).',
      'Thinks 3/6 is bigger than 1/2 because the numbers are bigger.',
    ],
    memory: [
      { kind: 'misconception', category: 'fractions', concept: 'fractions-expand', text: 'Expanded 2/3 by adding 2 to top and bottom: 4/5.', outcome: 'unknown', quote: 'plus 2 on top and plus 2 on the bottom, so 4/5' },
      { kind: 'strategy', category: 'fractions', concept: 'fractions-expand', text: 'Cutting each piece in two on a bar showed why we multiply.', outcome: 'worked' },
      { kind: 'quote', category: 'fractions', concept: 'fractions-expand', text: '"but my way works too"', outcome: 'didnt', quote: 'but my way works too' },
      { kind: 'understood', category: 'multiply-divide', concept: 'multiplication-groups', text: 'Strong mental multiplication.', outcome: 'worked', session: 1 },
    ],
    mastery: [{ concept: 'fractions-expand', mastery: 35 }, { concept: 'multiplication-groups', mastery: 90 }],
    history: [
      {
        daysAgo: 2,
        concept: 'fractions-expand',
        task: 'Expand 2/3 so the bottom number is 6.',
        summary:
          'Lucas expanded 2/3 by adding 2 to the top and the bottom and got 4/5. He argued that his way works too until cutting each piece of a fraction bar in two showed why we multiply (4/6). He was quick and competitive and got annoyed when wrong.',
        nextFocus: 'Expanding fractions: let him check his own answer on a bar; then compare 3/6 and 1/2.',
      },
      {
        daysAgo: 7,
        concept: 'multiplication-groups',
        task: 'Mental maths: 12 x 15 and 7 x 8.',
        summary:
          'Lucas did mental multiplication fast and got 12 x 15 and 7 x 8 right in seconds. He wanted instant feedback and lost patience with written steps.',
        nextFocus: 'Expanding fractions.',
      },
    ],
  },
  {
    rank: 20,
    name: 'Nora Kowalski',
    age: 8,
    grade: 3,
    style: 'pictures and gentle repetition',
    persona:
      'Sweet and eager to please, says "yes" even when she does not understand. Very short answers, sometimes copies the last number the tutor said. Loves unicorns and stickers.',
    misconceptions: [
      'Thinks 1/2 of 8 is 2 (halves and quarters mixed up).',
      'Believes the 2 in 25 means 2, not 20.',
    ],
    memory: [
      { kind: 'misconception', category: 'fractions', concept: 'fractions-unit', text: 'Said half of 8 is 2.', outcome: 'unknown', quote: 'half of 8 is 2' },
      { kind: 'misconception', category: 'numbers', concept: 'place-value', text: 'Read the 2 in 25 as two ones.', outcome: 'unknown', quote: 'the 2 is two', session: 1 },
      { kind: 'strategy', category: 'fractions', concept: 'fractions-unit', text: 'Sharing 8 stickers between 2 friends worked.', outcome: 'worked' },
      { kind: 'preference', category: 'fractions', concept: '', text: 'Says "yes" without understanding; ask her to show it.', outcome: 'didnt' },
    ],
    mastery: [{ concept: 'fractions-unit', mastery: 25 }, { concept: 'place-value', mastery: 30 }],
    history: [
      {
        daysAgo: 2,
        concept: 'fractions-unit',
        task: 'What is half of 8? Share the stickers.',
        summary:
          'Nora said half of 8 is 2. Sharing 8 unicorn stickers between 2 friends showed that each gets 4, and she got it right when she could move the stickers herself. She said "yes" to every check question, so the tutor asked her to show it instead.',
        nextFocus: 'Halves and quarters of small numbers with stickers; ask her to show it, not to say yes.',
      },
      {
        daysAgo: 6,
        concept: 'place-value',
        task: 'What is the 2 in 25 worth?',
        summary:
          'Nora read the 2 in 25 as two ones. Bundling sticks into tens helped a little, but a few times she just copied the last number the tutor said.',
        nextFocus: 'Place value of two-digit numbers with bundles of ten.',
      },
    ],
  },
];
