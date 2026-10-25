// Transcript comparison: normalize case, punctuation and number words, then word recall.

const NUM_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
];
const ORDINALS: Record<string, string> = {
  half: 'two', halves: 'two', third: 'three', thirds: 'three', fourth: 'four', fourths: 'four', quarter: 'four',
  quarters: 'four', fifth: 'five', fifths: 'five', sixth: 'six', sixths: 'six', eighth: 'eight', eighths: 'eight',
  twelfth: 'twelve', twelfths: 'twelve',
};
/** Hesitations: Whisper often drops them, so they never count. */
const FILLERS = new Set(['um', 'uh', 'umm', 'uhm', 'erm', 'hmm', 'mm', 'ah', 'oh']);

export function normalizeWords(s: string): string[] {
  const t = s
    .toLowerCase()
    .replace(/(\d+)\s*\/\s*(\d+)/g, '$1 $2') // 2/3 -> 2 3
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ');
  const out: string[] = [];
  for (const w of t.split(' ')) {
    if (!w || FILLERS.has(w)) continue;
    if (/^\d+$/.test(w)) {
      const n = Number(w);
      out.push(n <= 20 ? NUM_WORDS[n]! : w);
    } else out.push(ORDINALS[w] ?? w);
  }
  return out;
}

/** Share of the source's words (multiset) found in the transcript, 0..1. */
export function wordRecall(source: string, transcript: string): number {
  const src = normalizeWords(source);
  if (!src.length) return 1;
  const pool = new Map<string, number>();
  for (const w of normalizeWords(transcript)) pool.set(w, (pool.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of src) {
    const n = pool.get(w) ?? 0;
    if (n > 0) {
      hit++;
      pool.set(w, n - 1);
    }
  }
  return hit / src.length;
}
