// SpeechNormalizer: safety net turning leftover symbols into words ("3/4" -> "three quarters").
// Owned by the worker stream. Pure string functions, no Node or browser APIs.
//
// The prompt asks the LLM to say math in words; this catches what slips through: fractions,
// decimals, percent, operators, "=", exponents, parentheses like "2(x + 3)", LaTeX remnants and
// markdown. Numbers become words so TTS reads them consistently.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES: [bigint, string][] = [
  [1_000_000_000_000n, 'trillion'],
  [1_000_000_000n, 'billion'],
  [1_000_000n, 'million'],
  [1_000n, 'thousand'],
];

function under1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(TENS[Math.floor(n / 10)]! + (n % 10 ? `-${ONES[n % 10]}` : ''));
  } else if (n > 0 || parts.length === 0) {
    parts.push(ONES[n]!);
  }
  return parts.join(' ');
}

/** Cardinal words for a non-negative integer given as digits ("1000" -> "one thousand"). */
export function numberToWords(digits: string): string {
  const clean = digits.replace(/,/g, '');
  if (!/^\d+$/.test(clean)) return digits;
  if (clean.length > 15) return clean.split('').map(d => ONES[Number(d)]).join(' ');
  let n = BigInt(clean);
  if (n === 0n) return 'zero';
  const parts: string[] = [];
  for (const [value, name] of SCALES) {
    if (n >= value) {
      parts.push(`${under1000(Number(n / value))} ${name}`);
      n %= value;
    }
  }
  if (n > 0n) parts.push(under1000(Number(n)));
  return parts.join(' ');
}

const ORDINAL_IRREGULAR: Record<string, string> = {
  one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth',
};

/** Ordinal words: 3 -> "third", 21 -> "twenty-first", 100 -> "one hundredth". */
export function ordinalWords(digits: string): string {
  const words = numberToWords(digits);
  const m = words.match(/^(.*?)([a-z]+)$/);
  if (!m) return words;
  const [, head, last] = m as unknown as [string, string, string];
  let ord: string;
  if (ORDINAL_IRREGULAR[last]) ord = ORDINAL_IRREGULAR[last]!;
  else if (last.endsWith('y')) ord = `${last.slice(0, -1)}ieth`;
  else ord = `${last}th`;
  return head + ord;
}

/** Fraction words: (3, 4) -> "three quarters", (1, 2) -> "one half", (2, 3) -> "two thirds". */
export function fractionWords(num: string, den: string): string {
  const n = Number(num.replace(/,/g, ''));
  const d = Number(den.replace(/,/g, ''));
  const top = numberToWords(num);
  if (d === 0) return `${top} over zero`;
  if (d > 100) return `${top} over ${numberToWords(den)}`;
  const plural = n !== 1;
  let bottom: string;
  if (d === 1) return plural ? `${top} wholes` : `${top} whole`;
  if (d === 2) bottom = plural ? 'halves' : 'half';
  else if (d === 4) bottom = plural ? 'quarters' : 'quarter';
  else bottom = ordinalWords(den) + (plural ? 's' : '');
  return `${top} ${bottom}`;
}

function decimalWords(int: string, frac: string): string {
  return `${numberToWords(int || '0')} point ${frac.split('').map(d => ONES[Number(d)]).join(' ')}`;
}

/** Strips markdown and turns LaTeX remnants into plain text with ASCII operators. */
function stripMarkup(s: string): string {
  let t = s;
  // Inline board markers (⟦b1⟧, [[b1]]) are never spoken; prepareSentence (markers.ts) records them first.
  t = t.replace(/⟦[^⟧\n]{0,26}⟧|\[\[[^\]\n]{0,26}\]\]/g, ' ');
  // Markdown: links, images, code, emphasis, headings, bullets, block quotes.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/`{1,3}([^`]*)`{1,3}/g, '$1');
  t = t.replace(/(\*\*|__)(.+?)\1/g, '$2');
  t = t.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1$2');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '');
  t = t.replace(/^\s*>\s?/gm, '');

  // LaTeX. Blanks first so \frac{\square}{6} stays a simple fraction.
  t = t.replace(/\\(?:square|Box|blank)\b/g, ' blank ');
  // Repeat so nested \frac{\frac{..}{..}}{..} unwraps.
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_m, a: string, b: string) => {
      const simple = (x: string) => /^\s*[\w.]+\s*$/.test(x);
      return simple(a) && simple(b) ? `${a.trim()}/${b.trim()}` : `(${a}) over (${b})`;
    });
    t = t.replace(/\\sqrt\s*\{([^{}]*)\}/g, ' the square root of $1 ');
    t = t.replace(/\\(?:text|mathrm|mathbf|textbf|mathit|operatorname|boxed)\s*\{([^{}]*)\}/g, '$1');
    if (t === before) break;
  }
  t = t.replace(/\\(?:cdot|times|ast)\b/g, ' × ');
  t = t.replace(/\\div\b/g, ' ÷ ');
  t = t.replace(/\\pm\b/g, ' plus or minus ');
  t = t.replace(/\\(?:leq|le)\b/g, ' ≤ ');
  t = t.replace(/\\(?:geq|ge)\b/g, ' ≥ ');
  t = t.replace(/\\(?:neq|ne)\b/g, ' ≠ ');
  t = t.replace(/\\approx\b/g, ' ≈ ');
  t = t.replace(/\\(?:quad|qquad|,|;|!|:)/g, ' ');
  t = t.replace(/\\(?:left|right)\b/g, '');
  t = t.replace(/\\[()[\]]/g, ' ');
  t = t.replace(/\\[a-zA-Z]+/g, ' ');
  t = t.replace(/\$+/g, ' ');
  t = t.replace(/[{}]/g, ' ');
  return t;
}

const OPERAND = String.raw`(?:\d+(?:\.\d+)?|[a-zA-Z]\b|\))`;

/** Turns a sentence that may contain symbols into plain speakable words. */
export function normalizeForSpeech(sentence: string): string {
  let t = stripMarkup(sentence);

  // Unicode fractions and blanks.
  const VULGAR: Record<string, string> = { '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅕': '1/5', '⅛': '1/8' };
  t = t.replace(/[½⅓⅔¼¾⅕⅛]/g, c => ` ${VULGAR[c]} `);
  t = t.replace(/□|_{2,}|\?\?+/g, ' blank ');

  // Common written abbreviations.
  t = t.replace(/\be\.g\.,?/gi, 'for example');
  t = t.replace(/\bi\.e\.,?/gi, 'that is');
  t = t.replace(/\betc\./gi, 'and so on');

  // Ordinals like 1st, 2nd, 3rd, 4th.
  t = t.replace(/\b(\d+)(?:st|nd|rd|th)\b/g, (_m, n: string) => ordinalWords(n));

  // Exponents: x^2, 10^3, x².
  t = t.replace(/\^\s*\(?\s*2\s*\)?|²/g, ' squared ');
  t = t.replace(/\^\s*\(?\s*3\s*\)?|³/g, ' cubed ');
  t = t.replace(/\^\s*\(?\s*(-?\w+)\s*\)?/g, ' to the power of $1 ');
  t = t.replace(/√\s*/g, 'the square root of ');

  // Percent (before decimals so "2.5%" works): "50%" -> "50 percent".
  t = t.replace(/(\d)\s*%/g, '$1 percent');

  // Fractions of plain numbers: 3/4, 1 / 2. Not dates or ratios with more slashes (1/2/2024).
  t = t.replace(/(?<![\d/.])(\d+)\s*\/\s*(\d+)(?!\d|\/|\.\d)/g, (_m, a: string, b: string) => ` ${fractionWords(a, b)} `);
  // Any other slash between operands: x/2, (a + b)/c -> "over".
  t = t.replace(/([\w)])\s*\/\s*([\w(])/g, '$1 over $2');

  // Decimals: 3.5 -> three point five, .5 -> zero point five.
  t = t.replace(/(?<![\d.])(\d*)\.(\d+)(?!\d|\.\d)/g, (_m, a: string, b: string) => ` ${decimalWords(a, b)} `);

  // Implicit multiplication: 2(x + 3), (a)(b), 3x.
  t = t.replace(/(\d|\))\s*\(/g, '$1 times (');
  t = t.replace(/(\d)([a-zA-Z])\b/g, '$1 $2');

  // Operators between operands.
  t = t.replace(/\s*[×✕*·∙⋅]\s*/g, ' times ');
  t = t.replace(/(\d)\s+x\s+(?=\d)/g, '$1 times ');
  t = t.replace(/\s*÷\s*/g, ' divided by ');
  t = t.replace(/\s*\+\s*/g, ' plus ');
  // Minus: between numbers, spaced on both sides, or the unicode minus sign. Hyphenated words
  // ("two-thirds", "x-axis") stay as they are.
  t = t.replace(new RegExp(`(${OPERAND})\\s*−\\s*`, 'g'), '$1 minus ');
  t = t.replace(/(\d)\s*-\s*(?=\d)/g, '$1 minus ');
  t = t.replace(new RegExp(`(${OPERAND})\\s+-\\s+`, 'g'), '$1 minus ');
  t = t.replace(/(^|[\s(=])[−-]\s*(?=\d|[a-zA-Z]\b)/g, '$1negative ');
  t = t.replace(/(\d)\s*–\s*(?=\d)/g, '$1 to ');
  t = t.replace(/\s*≠\s*/g, ' is not equal to ');
  t = t.replace(/\s*≈\s*/g, ' is about ');
  t = t.replace(/\s*(?:≤|<=)\s*/g, ' is less than or equal to ');
  t = t.replace(/\s*(?:≥|>=)\s*/g, ' is greater than or equal to ');
  t = t.replace(/\s*=+\s*/g, ' equals ');
  t = t.replace(/(\S)\s*<\s*(?=\S)/g, '$1 is less than ');
  t = t.replace(/(\S)\s*>\s*(?=\S)/g, '$1 is greater than ');
  t = t.replace(/\s*[→⇒]\s*/g, ' gives ');
  t = t.replace(/\s*&\s*/g, ' and ');

  // Parentheses: math groups are read as "the group ...", prose parentheses become commas.
  for (let i = 0; i < 3; i++) {
    t = t.replace(/\(([^()]*)\)/g, (_m, inner: string) =>
      /\b(?:plus|minus|times|over|divided by|equals)\b/.test(inner) ? ` the group ${inner.trim()}, ` : `, ${inner.trim()}, `
    );
  }
  t = t.replace(/[()[\]]/g, ' ');

  // Remaining integers (with thousands separators) -> words.
  t = t.replace(/(?<![\w.])\d{1,3}(?:,\d{3})+(?![\d])|(?<![\w.])\d+(?![\d])/g, n => numberToWords(n));

  // Leftover symbols and whitespace cleanup.
  t = t.replace(/[#*_~^|\\`<>]/g, ' ');
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/\s+([,.!?;:])/g, '$1');
  t = t.replace(/,\s*,+/g, ',');
  t = t.replace(/,\s*([.!?])/g, '$1');
  t = t.replace(/^\s*,\s*/, '');
  t = t.replace(/,\s*$/, '');
  return t.trim();
}
