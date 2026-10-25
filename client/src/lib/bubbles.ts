// Teacher dashboard live chat: the bubbles of one student card, derived from the class-wide
// `turn` + `reply_sentence` rows (pure, unit-tested in test/bubbles.test.ts).
//
// Student bubbles come from student turns; tutor bubbles from the reply_sentence rows of one
// utterance, sentence by sentence as they are played (plus the one playing now), so a tutor
// bubble grows while the tutor speaks. Order: turn index; a tutor reply still in progress (no
// tutor turn yet) sits after the student turns written before its first sentence. The newest
// `cap` bubbles are kept, each truncated to `maxChars` at a word boundary.

export interface BubbleTurn {
  idx: number;
  role: string;
  text: string;
  intent: string;
  utteranceId: string;
  createdAtMs: number;
}

export interface BubbleSentence {
  utteranceId: string;
  idx: number;
  display: string;
  speech: string;
  status: string;
  createdAtMs: number;
}

export interface Bubble {
  key: string;
  who: 'student' | 'tutor';
  text: string;
  /** Tutor reply still being spoken (more sentences to come). */
  live: boolean;
}

export const BUBBLE_CAP = 6;
export const BUBBLE_MAX_CHARS = 150;

/** Shortens to at most `max` characters, cutting at a word boundary, with an ellipsis. */
export function truncateText(text: string, max = BUBBLE_MAX_CHARS): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–-]+$/, '')}…`;
}

/** Which sentences of one utterance are shown: the played ones, then the first one still playing. */
export function shownSentences(sentences: BubbleSentence[]): { shown: BubbleSentence[]; live: boolean } {
  const sorted = [...sentences].sort((a, b) => a.idx - b.idx);
  const shown: BubbleSentence[] = [];
  let live = false;
  for (const s of sorted) {
    if (s.status === 'played') shown.push(s);
    else if (s.status === 'ready' || s.status === 'pending') {
      if (s.status === 'ready' && !live) shown.push(s);
      live = true;
      break;
    }
    // dropped: never spoken, skipped
  }
  return { shown, live };
}

interface Draft extends Bubble {
  order: number;
}

export function sessionBubbles(
  turns: BubbleTurn[],
  sentences: BubbleSentence[],
  opts: { cap?: number; maxChars?: number; label?: (text: string, intent: string) => string } = {}
): Bubble[] {
  const cap = opts.cap ?? BUBBLE_CAP;
  const maxChars = opts.maxChars ?? BUBBLE_MAX_CHARS;
  const label = opts.label ?? ((text: string) => text.trim());
  const drafts: Draft[] = [];
  const tutorTurnByUtt = new Map<string, BubbleTurn>();
  for (const t of turns) if (t.role === 'tutor' && t.utteranceId !== '0') tutorTurnByUtt.set(t.utteranceId, t);

  for (const t of turns) {
    if (t.role !== 'student') continue;
    const text = label(t.text, t.intent);
    if (!text) continue;
    drafts.push({ key: `s${t.idx}`, who: 'student', text: truncateText(text, maxChars), live: false, order: t.idx });
  }

  const byUtt = new Map<string, BubbleSentence[]>();
  for (const s of sentences) byUtt.set(s.utteranceId, [...(byUtt.get(s.utteranceId) ?? []), s]);
  const sortedTurns = [...turns].sort((a, b) => a.idx - b.idx);
  for (const [utt, list] of byUtt) {
    const { shown, live } = shownSentences(list);
    if (shown.length === 0) continue;
    const turn = tutorTurnByUtt.get(utt);
    let order: number;
    if (turn) order = turn.idx;
    else {
      const first = Math.min(...list.map(s => s.createdAtMs));
      const before = sortedTurns.filter(t => t.createdAtMs <= first);
      order = (before.length ? before[before.length - 1]!.idx : -1) + 0.5;
    }
    const text = shown.map(s => (s.display || s.speech).trim()).filter(Boolean).join(' ');
    if (!text) continue;
    drafts.push({ key: `u${utt}`, who: 'tutor', text: truncateText(text, maxChars), live, order });
  }

  // Tutor turns without sentences (older history, text written directly).
  for (const t of turns) {
    if (t.role !== 'tutor' || byUtt.has(t.utteranceId) || !t.text.trim()) continue;
    drafts.push({ key: `t${t.idx}`, who: 'tutor', text: truncateText(t.text, maxChars), live: false, order: t.idx });
  }

  drafts.sort((a, b) => a.order - b.order || (a.who === b.who ? 0 : a.who === 'student' ? -1 : 1));
  return drafts.slice(-cap).map(({ key, who, text, live }) => ({ key, who, text, live }));
}

/** Same bubbles → same string (lets the dashboard keep the previous array and skip re-rendering a card). */
export function bubblesSignature(bubbles: Bubble[]): string {
  return bubbles.map(b => `${b.key}\u0001${b.live ? 1 : 0}\u0001${b.text}`).join('\u0002');
}
