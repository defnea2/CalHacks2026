// Tiny exact evaluator for the arithmetic LaTeX used in library steps and gap tasks.
// Supports integers, decimals (0.5 or 0{,}5), \frac{a}{b}, + - \cdot \times \div, parentheses,
// braces, and relation chains with = < > \lt \gt \le \ge \leq \geq \neq.
// Anything else (letters, \text, \square, units) makes it return null: "not checkable".
// Pure TypeScript; used by the pack contract tests to verify library answers.

export interface Rational {
  n: number;
  d: number;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

export function rat(n: number, d = 1): Rational {
  if (d === 0) throw new Error('division by zero');
  if (d < 0) [n, d] = [-n, -d];
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

const add = (a: Rational, b: Rational) => rat(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Rational, b: Rational) => rat(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Rational, b: Rational) => rat(a.n * b.n, a.d * b.d);
const div = (a: Rational, b: Rational) => rat(a.n * b.d, a.d * b.n);
export const ratEquals = (a: Rational, b: Rational) => a.n === b.n && a.d === b.d;
const cmp = (a: Rational, b: Rational) => Math.sign(a.n * b.d - b.n * a.d);

/** "0.25" -> 1/4, "12" -> 12. */
export function decimalToRational(s: string): Rational {
  const [i, f = ''] = s.split('.');
  const scale = 10 ** f.length;
  return rat(Number(i + f), scale);
}

type Tok =
  | { t: 'num'; v: Rational }
  | { t: 'op'; v: '+' | '-' | '*' | '/' }
  | { t: 'rel'; v: '=' | '<' | '>' | '<=' | '>=' | '!=' }
  | { t: 'frac' | '(' | ')' | '{' | '}' };

const COMMANDS: Record<string, Tok | null> = {
  cdot: { t: 'op', v: '*' },
  times: { t: 'op', v: '*' },
  div: { t: 'op', v: '/' },
  frac: { t: 'frac' },
  dfrac: { t: 'frac' },
  tfrac: { t: 'frac' },
  lt: { t: 'rel', v: '<' },
  gt: { t: 'rel', v: '>' },
  le: { t: 'rel', v: '<=' },
  leq: { t: 'rel', v: '<=' },
  ge: { t: 'rel', v: '>=' },
  geq: { t: 'rel', v: '>=' },
  neq: { t: 'rel', v: '!=' },
  ne: { t: 'rel', v: '!=' },
  left: null, // ignored
  right: null,
};

function tokenize(src: string): Tok[] | null {
  const s = src.replace(/\{,\}/g, '.');
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
      if (!m) return null;
      const name = m[1]!;
      i += m[0].length;
      if (name === ',' || name === ';' || name === '!' || name === ' ' || name === ':') continue; // spacing
      if (!(name in COMMANDS)) return null;
      const tok = COMMANDS[name];
      if (tok) out.push(tok);
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (num) {
      out.push({ t: 'num', v: decimalToRational(num[0]) });
      i += num[0].length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '!=') { out.push({ t: 'rel', v: two }); i += 2; continue; }
    if (c === '=' || c === '<' || c === '>') { out.push({ t: 'rel', v: c }); i++; continue; }
    if (c === '+' || c === '-') { out.push({ t: 'op', v: c }); i++; continue; }
    if (c === '*') { out.push({ t: 'op', v: '*' }); i++; continue; }
    if (c === ':') { out.push({ t: 'op', v: '/' }); i++; continue; }
    if (c === '(' || c === ')' || c === '{' || c === '}') { out.push({ t: c }); i++; continue; }
    if (c === '[') { out.push({ t: '(' }); i++; continue; }
    if (c === ']') { out.push({ t: ')' }); i++; continue; }
    return null;
  }
  return out;
}

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}
  private peek() { return this.toks[this.p]; }
  private eat(t: Tok['t']) {
    const k = this.toks[this.p];
    if (!k || k.t !== t) throw new Error(`expected ${t}`);
    this.p++;
    return k;
  }
  done() { return this.p >= this.toks.length; }
  expr(): Rational {
    let v = this.term();
    for (let k = this.peek(); k && k.t === 'op' && (k.v === '+' || k.v === '-'); k = this.peek()) {
      this.p++;
      v = k.v === '+' ? add(v, this.term()) : sub(v, this.term());
    }
    return v;
  }
  private term(): Rational {
    let v = this.unary();
    for (let k = this.peek(); k && k.t === 'op' && (k.v === '*' || k.v === '/'); k = this.peek()) {
      this.p++;
      v = k.v === '*' ? mul(v, this.unary()) : div(v, this.unary());
    }
    return v;
  }
  private unary(): Rational {
    const k = this.peek();
    if (k && k.t === 'op' && k.v === '-') { this.p++; return mul(rat(-1), this.unary()); }
    if (k && k.t === 'op' && k.v === '+') { this.p++; return this.unary(); }
    return this.primary();
  }
  private group(): Rational {
    this.eat('{');
    const v = this.expr();
    this.eat('}');
    return v;
  }
  private primary(): Rational {
    const k = this.peek();
    if (!k) throw new Error('unexpected end');
    if (k.t === 'num') { this.p++; return k.v; }
    if (k.t === 'frac') { this.p++; const a = this.group(); const b = this.group(); return div(a, b); }
    if (k.t === '{') return this.group();
    if (k.t === '(') { this.p++; const v = this.expr(); this.eat(')'); return v; }
    throw new Error(`unexpected ${k.t}`);
  }
  relation(): Tok & { t: 'rel' } | undefined {
    const k = this.peek();
    if (k && k.t === 'rel') { this.p++; return k as Tok & { t: 'rel' }; }
    return undefined;
  }
}

export interface Chain {
  /** Values of the sides, left to right. */
  sides: Rational[];
  /** Relations between neighbouring sides. */
  relations: string[];
  /** True when every relation holds. */
  holds: boolean;
  /** Raw LaTeX of the last side (to check the exact form of a fraction). */
  lastRaw: string;
}

export const REL_SPLIT = /\\(?:lt|gt|leq?|geq?|neq?)(?![a-zA-Z])|<=|>=|!=|=|<|>/;

/** Evaluates a relation chain like "\frac{3}{5} = \frac{12}{20}" or a bare expression. Null = not checkable. */
export function evaluateChain(latex: string): Chain | null {
  const toks = tokenize(latex);
  if (!toks || toks.length === 0) return null;
  try {
    const ps = new Parser(toks);
    const sides = [ps.expr()];
    const relations: string[] = [];
    for (let r = ps.relation(); r; r = ps.relation()) {
      relations.push(r.v);
      sides.push(ps.expr());
    }
    if (!ps.done()) return null;
    let holds = true;
    relations.forEach((r, i) => {
      const c = cmp(sides[i]!, sides[i + 1]!);
      const ok = r === '=' ? c === 0 : r === '<' ? c < 0 : r === '>' ? c > 0 : r === '<=' ? c <= 0 : r === '>=' ? c >= 0 : c !== 0;
      if (!ok) holds = false;
    });
    const parts = latex.split(REL_SPLIT);
    return { sides, relations, holds, lastRaw: parts[parts.length - 1]!.trim() };
  } catch {
    return null;
  }
}

/** Value of a single expression, or null. */
export function evaluateExpression(latex: string): Rational | null {
  const c = evaluateChain(latex);
  return c && c.relations.length === 0 ? c.sides[0]! : null;
}

/** "\frac{12}{20}" -> [12, 20] (exact written form), else null. */
export function literalFraction(latex: string): [number, number] | null {
  const m = /^\\[dt]?frac\s*\{\s*(\d+)\s*\}\s*\{\s*(\d+)\s*\}$/.exec(latex.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Answer value -> LaTeX to substitute for \square ("3/6" -> "\frac{3}{6}", "<" -> "<"). */
export function answerToLatex(value: string): string {
  const v = value.trim();
  const f = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(v);
  if (f) return `\\frac{${f[1]}}{${f[2]}}`;
  return v.replace(',', '.');
}

export const BLANK = '\\square';

/** Substitutes `value` for the single \square in `latex`. Null if there isn't exactly one blank. */
export function fillBlank(latex: string, value: string): string | null {
  const parts = latex.split(BLANK);
  if (parts.length !== 2) return null;
  const v = answerToLatex(value);
  const isRelation = REL_SPLIT.test(v);
  return parts[0] + (isRelation ? ` ${v} ` : ` {${v}} `) + parts[1];
}
