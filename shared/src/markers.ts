// Inline board markers. The tutor writes ⟦b1⟧ in its spoken text exactly where a board item
// should appear and puts the matching tool call (`id: "b1"`) at the end of its reply. Markers
// never reach the display or the speech: prepareSentence strips them and records, per marker,
// the character offset in the sentence's speech text, so the client can reveal the item at
// that word. Tool-agnostic: any tool argument named `id` can refer to a marker.
//
// Accepted forms: ⟦id⟧ (what the prompt asks for) and [[id]]. Ids are 1-24 of [A-Za-z0-9_-] and
// compared case-insensitively. Malformed remnants (unclosed "⟦b1", "[[ ]]", stray "⟧") are
// removed without an anchor, so they are never spoken.
import { normalizeForSpeech } from './normalizer';

export const MARKER_OPEN = '⟦';
export const MARKER_CLOSE = '⟧';
export const markerText = (id: string) => `${MARKER_OPEN}${id}${MARKER_CLOSE}`;
/** Appended to query results that go back to the model in the same reply: the long library
 *  material otherwise pushes the marker rule out of focus (measured with the real model). */
export const markerReminder = (boardTool: string) =>
  `(Reminder: in your reply, write ${markerText('b1')} right after the words about each board item, then call ${boardTool} with id "b1" after your text.)`;

const ID = '[A-Za-z0-9_-]{1,24}';
const WELL_FORMED = new RegExp(String.raw`⟦\s*(${ID})\s*⟧|\[\[\s*(${ID})\s*\]\]`, 'g');
const MALFORMED = /⟦\s*[\w-]{0,24}\s*⟧?|⟧|\[\[\s*[\w-]{0,24}\s*\]{0,2}|\]\]/g;
/** Quick test without allocating (stream hot path). */
const ANY = /⟦|⟧|\[\[|\]\]/;

export interface SentenceMarker {
  /** Lower-cased marker id. */
  id: string;
  /** Character offset in the sentence's speech text: the first character after the marker
   *  (skipping spaces), or speech.length when the marker ends the sentence. */
  pos: number;
}

export interface PreparedSentence {
  display: string;
  speech: string;
  markers: SentenceMarker[];
}

export const normalizeMarkerId = (id: string) => id.trim().toLowerCase();

export function hasMarkers(text: string): boolean {
  return ANY.test(text);
}

/** Text with all markers (and malformed remnants) removed, whitespace tidied. */
export function stripMarkers(text: string): string {
  if (!hasMarkers(text)) return text;
  return tidyTrack(text.replace(WELL_FORMED, ' ').replace(MALFORMED, ' '), () => {}).text;
}

/** Ids of the well-formed markers in `text`, in order (lower-cased, unique). */
export function markerIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WELL_FORMED)) {
    const id = normalizeMarkerId(m[1] ?? m[2] ?? '');
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

const SENTINEL_BASE = 0xe000; // Unicode private use area: no normalizer rule touches it
const SENTINEL_RE = /[-]/;
const PUNCT = /[,.!?;:…]/;

/**
 * Whitespace tidy (collapse runs, no space before , . ! ? ; :, trim) that drops sentinel
 * characters and reports where each one ended up: the offset of the next non-space output
 * character, or the output length at the end.
 */
function tidyTrack(s: string, onSentinel: (n: number, pos: number) => void): { text: string } {
  let out = '';
  let space = false;
  const pending: number[] = [];
  const settle = (pos: number) => {
    for (const n of pending.splice(0)) onSentinel(n, pos);
  };
  for (const ch of s) {
    if (SENTINEL_RE.test(ch)) {
      pending.push(ch.codePointAt(0)! - SENTINEL_BASE);
    } else if (/\s/.test(ch)) {
      space = out.length > 0;
    } else if (PUNCT.test(ch)) {
      space = false;
      settle(out.length);
      out += ch;
    } else {
      if (space) out += ' ';
      space = false;
      settle(out.length);
      out += ch;
    }
  }
  settle(out.length);
  return { text: out };
}

/**
 * One chunker sentence -> display + speech without markers, plus marker positions in the
 * speech text. `normalize` is the speech normalizer (injectable for tests).
 */
export function prepareSentence(raw: string, normalize: (s: string) => string = normalizeForSpeech): PreparedSentence {
  if (!hasMarkers(raw)) {
    const speech = normalize(raw) || raw;
    return { display: raw, speech, markers: [] };
  }
  const ids: string[] = [];
  const withSentinels = raw
    .replace(WELL_FORMED, (_m, a?: string, b?: string) => {
      const id = normalizeMarkerId(a ?? b ?? '');
      if (ids.length >= 256) return ' ';
      ids.push(id);
      return String.fromCodePoint(SENTINEL_BASE + ids.length - 1);
    })
    .replace(MALFORMED, ' ');
  const display = tidyTrack(withSentinels, () => {}).text;
  const found = new Map<number, number>();
  let speech = tidyTrack(normalize(withSentinels), (n, pos) => {
    if (!found.has(n)) found.set(n, pos);
  }).text;
  if (!speech) speech = display; // normalizer returned nothing; never send an empty sentence
  // A sentinel the normalizer dropped (should not happen): place it by its share of the display.
  const displayPos = new Map<number, number>();
  tidyTrack(withSentinels, (n, pos) => displayPos.set(n, pos));
  const markers = ids.map((id, n) => {
    let pos = found.get(n);
    if (pos === undefined) pos = Math.round(((displayPos.get(n) ?? display.length) / Math.max(1, display.length)) * speech.length);
    return { id, pos: Math.min(pos, speech.length) };
  });
  return { display, speech, markers };
}
