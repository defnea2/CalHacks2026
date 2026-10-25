const units = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const tens = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];
function under100(words: string[]): number | null {
  if (words.length === 1 && units.includes(words[0]))
    return units.indexOf(words[0]);
  const t = tens.indexOf(words[0]);
  if (t >= 2 && words.length === 1) return t * 10;
  const u = units.indexOf(words[1]);
  if (t >= 2 && words.length === 2 && u > 0 && u < 10) return t * 10 + u;
  return null;
}
function integer(words: string[]): number | null {
  const h = units.indexOf(words[0]);
  if (h > 0 && h < 10 && words[1] === "hundred") {
    const rest = words.slice(words[2] === "and" ? 3 : 2);
    if (!rest.length) return words[2] === "and" ? null : h * 100;
    const n = under100(rest);
    return n === null ? null : h * 100 + n;
  }
  return under100(words);
}
/** Exact numeric literals and simple English number phrases; no guessing from prose. */
export function parseSpokenNumber(text: string): number | null {
  const value = text.trim().toLowerCase().replace(/[.!]$/, "").trim();
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  const words = value.replace(/-/g, " ").split(/\s+/);
  const sign = ["minus", "negative"].includes(words[0])
    ? (words.shift(), -1)
    : 1;
  const point = words.indexOf("point");
  const whole = integer(point < 0 ? words : words.slice(0, point));
  if (whole === null) return null;
  if (point < 0) return sign * whole;
  const decimals = words.slice(point + 1).map((w) => units.indexOf(w));
  if (!decimals.length || decimals.some((n) => n < 0 || n > 9)) return null;
  return sign * Number(whole + "." + decimals.join(""));
}

// ------------------------------------------------------------------ numbers inside sentences (check guards, grading)

export type NumberItem = { kind: "num"; value: number } | { kind: "frac"; num: number; den: number } | { kind: "den"; den: number };

export const UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
export const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
// "second" is left out on purpose (time, order).
const ORDINALS: Record<string, number> = {
  half: 2, halves: 2, third: 3, quarter: 4, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
  nineteenth: 19, twentieth: 20, hundredth: 100, thousandth: 1000,
};
export function ordinal(word: string | undefined): number | undefined {
  if (!word) return undefined;
  return ORDINALS[word] ?? (word.endsWith("s") ? ORDINALS[word.slice(0, -1)] : undefined);
}
function cardinal(words: string[], i: number): { value: number; next: number } | null {
  const u = UNITS.indexOf(words[i] ?? "");
  if (u >= 0) return { value: u, next: i + 1 };
  const t = TENS.indexOf(words[i] ?? "");
  if (t < 2) return null;
  const v = UNITS.indexOf(words[i + 1] ?? "");
  return v > 0 && v < 10 ? { value: t * 10 + v, next: i + 2 } : { value: t * 10, next: i + 1 };
}

/** Numbers, fractions and bare denominators ("how many sixths") in a sentence, in order. */
export function numberItems(text: string): NumberItem[] {
  const tokens = text.toLowerCase().replace(/(\d),(\d{3})/g, "$1$2").match(/\d+\s*\/\s*\d+|\d*\.\d+|\d+|\p{L}+/gu) ?? [];
  const out: NumberItem[] = [];
  for (let i = 0; i < tokens.length; ) {
    const tok = tokens[i]!;
    let value: number | null = null;
    let next = i + 1;
    if (tok.includes("/")) {
      const [a, b] = tok.split("/").map(s => Number(s.trim()));
      out.push(b ? { kind: "frac", num: a!, den: b } : { kind: "num", value: a! });
      i = next;
      continue;
    }
    if (/^[\d.]+$/.test(tok)) value = Number(tok);
    else if ((tok === "a" || tok === "an") && ordinal(tokens[i + 1])) value = 1;
    else {
      const c = cardinal(tokens, i);
      if (c) {
        value = c.value;
        next = c.next;
        // "zero point two five"
        if (tokens[next] === "point") {
          const digits: number[] = [];
          let j = next + 1;
          while (j < tokens.length) {
            const d = /^\d$/.test(tokens[j]!) ? Number(tokens[j]) : UNITS.indexOf(tokens[j]!);
            if (d < 0 || d > 9) break;
            digits.push(d);
            j++;
          }
          if (digits.length) {
            value = Number(`${value}.${digits.join("")}`);
            next = j;
          }
        }
      }
    }
    if (value === null) {
      const den = ordinal(tok);
      if (den) out.push({ kind: "den", den });
      i = next;
      continue;
    }
    const den = ordinal(tokens[next]);
    if (den && Number.isInteger(value)) {
      out.push({ kind: "frac", num: value, den });
      next++;
    } else if (tokens[next] === "over" || (tokens[next] === "out" && tokens[next + 1] === "of")) {
      const at = tokens[next] === "over" ? next + 1 : next + 2;
      const d = /^\d+$/.test(tokens[at] ?? "") ? { value: Number(tokens[at]), next: at + 1 } : cardinal(tokens, at);
      if (d && d.value > 0) {
        out.push({ kind: "frac", num: value, den: d.value });
        next = d.next;
      } else out.push({ kind: "num", value });
    } else out.push({ kind: "num", value });
    i = next;
  }
  return out;
}

/** Every number named in a text (a fraction contributes both its numbers, "sixths" contributes 6). */
export function numbersIn(text: string): number[] {
  return numberItems(text).flatMap(x => (x.kind === "num" ? [x.value] : x.kind === "frac" ? [x.num, x.den] : [x.den]));
}

/** The single number or fraction an answer names ("I think nine twelfths", "9/12", "it's nine"); null if none or several. */
export function spokenValue(text: string): Extract<NumberItem, { kind: "num" | "frac" }> | null {
  const items = numberItems(text).filter((x): x is Extract<NumberItem, { kind: "num" | "frac" }> => x.kind !== "den");
  return items.length === 1 ? items[0]! : null;
}

