// Deterministic answer checking for gap tasks and library tasks.
import type { ExpectedAnswer } from './types';

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

function clean(s: string): string {
  return s.trim().toLowerCase().replace(/[.,!?]+$/g, '').replace(/\s+/g, ' ');
}

/** "3", "3.5", "0,5", "three", "twenty four" -> number; null if not a number. */
export function parseNumber(raw: string): number | null {
  const s = clean(raw).replace(',', '.');
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const words = s.replace(/-/g, ' ').split(' ').filter(w => w && w !== 'and');
  if (!words.length || !words.every(w => w in WORD_NUMBERS)) return null;
  let total = 0;
  for (const w of words) {
    const v = WORD_NUMBERS[w]!;
    total = v === 100 ? (total || 1) * 100 : total + v;
  }
  return total;
}

/** "3/6", "3 / 6", "3 over 6" -> [3, 6]; null if not a fraction. */
export function parseFraction(raw: string): [number, number] | null {
  const s = clean(raw).replace(/\s+(over|out of)\s+/, '/');
  const m = s.match(/^(.+?)\s*\/\s*(.+)$/);
  if (!m) return null;
  const n = parseNumber(m[1]!);
  const d = parseNumber(m[2]!);
  return n === null || d === null || d === 0 ? null : [n, d];
}

/**
 * Checks a student's answer. Fractions must match in form (3/6 is not accepted for 1/2),
 * because tasks like expanding ask for a specific form. Numbers compare by value.
 */
export function checkAnswer(expected: ExpectedAnswer, given: string): boolean {
  switch (expected.form) {
    case 'number': {
      const e = parseNumber(expected.value);
      const g = parseNumber(given);
      return e !== null && g !== null && Math.abs(e - g) < 1e-9;
    }
    case 'fraction': {
      const e = parseFraction(expected.value);
      const g = parseFraction(given);
      return e !== null && g !== null && e[0] === g[0] && e[1] === g[1];
    }
    case 'choice':
    case 'text':
      return clean(expected.value) === clean(given);
  }
}
