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
