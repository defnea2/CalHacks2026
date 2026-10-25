// SentenceChunker: token stream -> speakable sentences. Owned by the worker stream.
// Rules (spec): cut at . ! ?; sentences over 25 words at ; : or a comma before a conjunction;
// never pieces under ~6 words; never inside numbers, abbreviations or math.
//
// Like LiveKit's basic sentence tokenizer, sentences shorter than `minWords` are merged with
// the next one ("Great job! Let's look at the bottom number." is one piece), so TTS never gets
// a two-word fragment.
//
// A sentence at the end of the buffer is emitted at once (no waiting for the next token) when it
// ends in ! or ?, or in a single . that cannot be a decimal point (digit before it), an
// abbreviation/title ("e.g.", "Mr."), an initial ("J.") or an ellipsis, and no quote, bracket or
// math is open. Every other boundary is confirmed only once the next non-space character has
// arrived, so "e.g. the", "Mr. Smith" or "3.5" are never cut.

export interface SentenceChunkerOptions {
  maxWords?: number; // default 25
  minWords?: number; // default 6
  /** Minimum for the first piece only (default: minWords). 1 lets a short opening sentence
   *  ("Great thinking!") go to TTS on its own, so speech starts sooner. */
  firstMinWords?: number;
}

/** Titles: a period after these never ends a sentence. */
const TITLES = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'sr', 'jr', 'vs', 'fig', 'approx', 'ca']);
/** Abbreviations that end with a period but rarely end a sentence. */
const ABBREV = new Set(['e.g', 'i.e', 'etc', 'cf', 'a.m', 'p.m', 'u.s', 'eg', 'ie']);
const CONJUNCTIONS = new Set([
  'and', 'but', 'or', 'so', 'because', 'then', 'while', 'although', 'though', 'which', 'when', 'yet', 'since', 'until', 'unless', 'where',
]);

/** Terminal punctuation run, optional closing quotes/brackets, then whitespace and a lookahead char. */
const BOUNDARY = /[.!?…]+["'”’)\]]*(?=\s+(\S))|\n+(?=\s*(\S))/g;

/** Sentence end at the very end of the buffer: punctuation run, closing quotes/brackets, spaces. */
const TRAILING = /([.!?]+)["'”’)\]]*\s*$/;

/** Emitted pieces: trimmed, inner whitespace (incl. newlines) collapsed. */
const tidy = (s: string) => s.trim().replace(/\s+/g, ' ');

function countWords(s: string): number {
  const m = s.trim().match(/\S+/g);
  return m ? m.length : 0;
}

/** True if `text` (from the start of the pending piece) is inside unclosed math or brackets. */
function insideMath(text: string): boolean {
  let paren = 0;
  let dollars = 0;
  let latexParen = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && (text[i + 1] === '(' || text[i + 1] === '[')) {
      latexParen++;
      i++;
    } else if (c === '\\' && (text[i + 1] === ')' || text[i + 1] === ']')) {
      latexParen = Math.max(0, latexParen - 1);
      i++;
    } else if (c === '$') dollars++;
    else if (c === '(' || c === '[' || c === '{') paren++;
    else if (c === ')' || c === ']' || c === '}') paren = Math.max(0, paren - 1);
  }
  return paren > 0 || latexParen > 0 || dollars % 2 === 1;
}

/** Is the punctuation match at [start, end) of `text` a real sentence end, given the next char? */
function isRealBoundary(text: string, start: number, punct: string, next: string): boolean {
  if (punct.startsWith('\n')) return !insideMath(text.slice(0, start));
  // Lowercase continuation: "e.g. the", "3 p.m. today", "wait... then".
  if (/^[a-z]/.test(next)) return false;
  if (punct[0] === '.') {
    // Word right before the period (may contain inner periods: "e.g", "a.m").
    const before = text.slice(0, start).match(/([A-Za-z][A-Za-z.]*)$/);
    const word = before ? before[1]!.toLowerCase() : '';
    if (word && (TITLES.has(word) || ABBREV.has(word))) return false;
    // Single capital initial like "J. K." -> not an end.
    if (/^[A-Z]$/.test(before?.[1] ?? '') && /^[A-Z]/.test(next)) return false;
  }
  return !insideMath(text.slice(0, start));
}

/** Can the punctuation run `punct` at `start` (end of the buffer) end a sentence without
 *  seeing the next character? */
function isSureEnd(text: string, start: number, punct: string): boolean {
  if (!/[!?]/.test(punct)) {
    if (punct !== '.') return false; // ".." / "..." may continue ("wait... then")
    const before = text.slice(0, start);
    if (/\d$/.test(before)) return false; // "3." may become "3.5"
    const w = before.match(/([A-Za-z][A-Za-z.]*)$/)?.[1] ?? '';
    if (w && (TITLES.has(w.toLowerCase()) || ABBREV.has(w.toLowerCase()))) return false;
    if (/^[A-Z]$/.test(w)) return false; // initial "J."
  }
  // An open double quote may still be closed right after the punctuation ('size."').
  const straight = (text.match(/"/g) ?? []).length;
  const open = (text.match(/“/g) ?? []).length - (text.match(/”/g) ?? []).length;
  if (straight % 2 === 1 || open > 0) return false;
  return !insideMath(text.slice(0, start));
}

/** Candidate split points for long sentences: after ; or : (followed by space), or before a
 *  conjunction that follows a comma. Returns char offsets where the right piece starts. */
function longSplitPoints(text: string): number[] {
  const pts: number[] = [];
  const re = /[;:](?=\s)|,(?=\s+(\w+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0] === ',' && !CONJUNCTIONS.has((m[1] ?? '').toLowerCase())) continue;
    if (m[0] === ':' && /\d$/.test(text.slice(0, m.index)) && /^\s*\d/.test(text.slice(m.index + 1))) continue; // 3:4 ratio-ish
    if (insideMath(text.slice(0, m.index))) continue;
    let p = m.index + 1;
    while (p < text.length && /\s/.test(text[p]!)) p++;
    pts.push(p);
  }
  return pts;
}

export class SentenceChunker {
  private readonly maxWords: number;
  private readonly minWords: number;
  private readonly firstMinWords: number;
  private emitted = 0;
  private buf = '';

  constructor(opts: SentenceChunkerOptions = {}) {
    this.maxWords = opts.maxWords ?? 25;
    this.minWords = opts.minWords ?? 6;
    this.firstMinWords = opts.firstMinWords ?? this.minWords;
  }

  private get min(): number {
    return this.emitted === 0 ? this.firstMinWords : this.minWords;
  }

  /** Feed a token delta; returns zero or more complete sentences. */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const end = this.findBoundary();
      if (end < 0) break;
      const sentence = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end).replace(/^\s+/, '');
      out.push(...this.splitLong(sentence).map(tidy));
      this.emitted++;
    }
    // Rare fallback: a sentence that runs on without terminal punctuation.
    if (countWords(this.buf) > this.maxWords) {
      const pieces = this.splitLong(this.buf.replace(/^\s+/, ''));
      if (pieces.length > 1) {
        // The last piece is still growing; keep it (with its trailing whitespace) in the buffer.
        this.buf = pieces.pop()!;
        out.push(...pieces.map(tidy));
      }
    }
    return out;
  }

  /** The text paused at a point where something else follows (e.g. a tool call): emits the
   *  buffer if it ends at a sentence end, without waiting for the next character. */
  flushComplete(): string[] {
    const m = this.buf.match(/[.!?…]+["'”’)\]]*\s*$/);
    if (!m || !isRealBoundary(this.buf, m.index!, m[0], 'X')) return [];
    return this.flush();
  }

  /** End of stream: returns the remainder as a final sentence, if any. */
  flush(): string[] {
    const s = this.buf.trim();
    this.buf = '';
    return s ? this.splitLong(s).map(tidy) : [];
  }

  /** End offset of the first confirmed boundary whose piece has >= minWords words, or -1. */
  private findBoundary(): number {
    BOUNDARY.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BOUNDARY.exec(this.buf))) {
      const next = m[1] ?? m[2] ?? '';
      const end = m.index + m[0].length;
      if (!isRealBoundary(this.buf, m.index, m[0], next)) continue;
      if (countWords(this.buf.slice(0, end)) < this.min) continue; // merge with the next sentence
      return end;
    }
    // Nothing confirmed by a next character: a sure sentence end at the very end still counts.
    const t = this.buf.match(TRAILING);
    if (t && countWords(this.buf) >= this.min && isSureEnd(this.buf, t.index!, t[1]!)) return this.buf.length;
    return -1;
  }

  /** Splits a sentence over maxWords at ; : or ", <conjunction>", never leaving a piece under
   *  minWords. The last piece keeps its trailing whitespace (it may still be growing). */
  private splitLong(text: string): string[] {
    if (countWords(text) <= this.maxWords) return [text];
    const pts = longSplitPoints(text);
    let best = -1;
    let bestWords = -1;
    for (const p of pts) {
      const left = countWords(text.slice(0, p));
      const right = countWords(text.slice(p));
      if (left < this.minWords || right < this.minWords) continue;
      // Prefer the longest left piece that fits; otherwise the shortest one over the limit.
      const fits = left <= this.maxWords;
      const better = best < 0 || (fits ? bestWords > this.maxWords || left > bestWords : bestWords > this.maxWords && left < bestWords);
      if (better) {
        best = p;
        bestWords = left;
      }
    }
    if (best < 0) return [text];
    const left = text.slice(0, best).trim();
    const right = text.slice(best);
    return [left, ...this.splitLong(right)];
  }
}
