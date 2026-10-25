// SentenceChunker: token stream -> speakable sentences. Owned by the worker stream.
// Rules (spec): cut at . ! ?; sentences over 25 words at ; : or a comma before a conjunction;
// never pieces under ~6 words; never inside numbers, abbreviations or math.

export interface SentenceChunkerOptions {
  maxWords?: number; // default 25
  minWords?: number; // default 6
}

export class SentenceChunker {
  constructor(private readonly opts: SentenceChunkerOptions = {}) {}

  private buf = '';

  /** Feed a token delta; returns zero or more complete sentences. */
  push(delta: string): string[] {
    // TODO(worker stream): full implementation with abbreviation/number/math guards and long-sentence fallback.
    this.buf += delta;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    const re = /[.!?]+(?=\s)/g;
    let last = 0;
    while ((m = re.exec(this.buf))) {
      const s = this.buf.slice(last, m.index + m[0].length).trim();
      if (s) out.push(s);
      last = m.index + m[0].length;
    }
    this.buf = this.buf.slice(last);
    void this.opts;
    return out;
  }

  /** End of stream: returns the remainder as a final sentence, if any. */
  flush(): string[] {
    const s = this.buf.trim();
    this.buf = '';
    return s ? [s] : [];
  }
}
