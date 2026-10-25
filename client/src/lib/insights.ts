// Teacher-facing student profile: pure helpers that turn the `learnerInsights` procedure result
// (long-term memory: notes, mastery, session summaries) into plain teacher language.
// No LLM call: the "At a glance" line is built deterministically from the data.
import type { InsightNote, LearnerInsights, LearnerInsightsResult } from '@tutor/shared';

export type { InsightNote, LearnerInsights, LearnerInsightsResult };

const DAY = 86_400_000;

// ------------------------------------------------------------------ parsing + errors

/** Parses the procedure's JSON string; anything malformed becomes a plain error. */
export function parseInsights(json: string): LearnerInsightsResult | { ok: false; error: 'bad_response' } {
  try {
    const r = JSON.parse(json || '{}') as Partial<LearnerInsightsResult>;
    if (r && r.ok === true && 'learner' in r && r.learner) {
      const x = r as LearnerInsights;
      return { ...x, notes: x.notes ?? [], mastery: x.mastery ?? [], summaries: x.summaries ?? [] };
    }
    if (r && r.ok === false && typeof (r as { error?: unknown }).error === 'string') return r as LearnerInsightsResult;
  } catch {
    /* fall through */
  }
  return { ok: false, error: 'bad_response' };
}

/** `ok:false` reasons (and call failures) in plain words. */
export function errorText(error: string): string {
  switch (error) {
    case 'unknown_teacher':
      return 'This teacher is not known, so the profile cannot be shown.';
    case 'locked':
      return 'Student profiles are locked. Ask the organiser for the profile key and enter it on this device.';
    case 'unknown_learner':
      return 'This student is not in the system any more.';
    case 'bad_response':
      return 'The profile came back in an unexpected form. Try Refresh.';
    default:
      return `The profile could not be loaded (${error}). Try Refresh.`;
  }
}

// ------------------------------------------------------------------ words for numbers

/** Relative date: "just now", "5 minutes ago", "yesterday", "3 days ago", "2 weeks ago", else a date. */
export function relativeDate(now: number, ms: number): string {
  if (!ms) return 'unknown date';
  const d = Math.max(0, now - ms);
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) {
    const m = Math.floor(d / 60_000);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (d < DAY) {
    const h = Math.floor(d / 3_600_000);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(d / DAY);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** How sure the tutor is: confidence 0..1 → word. Notes below 0.7 are never stored. */
export function confidenceWord(confidence: number): 'clearly' | 'likely' | 'maybe' {
  if (confidence >= 0.85) return 'clearly';
  if (confidence >= 0.7) return 'likely';
  return 'maybe';
}

/** `reinforced` counts repeat sightings after the first one. */
export function seenLabel(reinforced: number): string {
  const n = 1 + Math.max(0, Math.floor(reinforced || 0));
  return n === 1 ? 'seen once' : n === 2 ? 'seen twice' : `seen ${n} times`;
}

export type MasteryBand = 'not started' | 'beginning' | 'getting there' | 'secure' | 'mastered';

export function masteryBand(mastery: number): MasteryBand {
  const m = Math.max(0, Math.min(100, mastery || 0));
  if (m === 0) return 'not started';
  if (m < 30) return 'beginning';
  if (m < 60) return 'getting there';
  if (m < 85) return 'secure';
  return 'mastered';
}

// ------------------------------------------------------------------ sections

export type SectionKey = 'mixing' | 'helps' | 'didnt' | 'aids' | 'cando' | 'words';

export interface NoteSection {
  key: SectionKey;
  title: string;
  hint: string;
  notes: InsightNote[];
}

const SECTIONS: { key: SectionKey; title: string; hint: string; match: (n: InsightNote) => boolean }[] = [
  { key: 'mixing', title: 'Still mixing up', hint: 'Misconceptions the tutor has noticed', match: n => n.kind === 'misconception' },
  { key: 'helps', title: 'What helps', hint: 'Approaches that worked and how they like to learn', match: n => (n.kind === 'strategy' && n.outcome !== 'didnt') || n.kind === 'preference' },
  { key: 'didnt', title: "What didn't help", hint: 'Approaches that did not land', match: n => n.kind === 'strategy' && n.outcome === 'didnt' },
  { key: 'aids', title: 'Memory aids', hint: 'Rhymes and tricks that stuck', match: n => n.kind === 'mnemonic' },
  { key: 'cando', title: 'Can do now', hint: 'Understood and shown in a session', match: n => n.kind === 'understood' },
  { key: 'words', title: 'In their own words', hint: 'Things they said', match: n => n.kind === 'quote' },
];

/** Strongest first: confidence × sightings, then most recent. */
function noteWeight(n: InsightNote): number {
  return (n.confidence || 0) * (1 + Math.max(0, n.reinforced || 0));
}
export function sortNotes(notes: InsightNote[]): InsightNote[] {
  return [...notes].sort((a, b) => noteWeight(b) - noteWeight(a) || (b.updatedMs || 0) - (a.updatedMs || 0));
}

/** Notes grouped into teacher sections, in a fixed order; empty sections are left out. */
export function noteSections(notes: InsightNote[]): NoteSection[] {
  return SECTIONS.map(s => ({ key: s.key, title: s.title, hint: s.hint, notes: sortNotes(notes.filter(s.match)) })).filter(s => s.notes.length > 0);
}

/** A note's text as one clean sentence (quotes keep their quotation marks). */
export function noteSentence(n: InsightNote): string {
  let t = (n.text || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  if (n.kind === 'quote') {
    t = t.replace(/^["“]|["”]$/g, '');
    return `“${t}”`;
  }
  t = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** Small meta line under a note: "clearly · seen 3 times · 2 days ago". */
export function noteMeta(now: number, n: InsightNote): string {
  const parts: string[] = [];
  if (n.kind !== 'quote') parts.push(confidenceWord(n.confidence));
  parts.push(seenLabel(n.reinforced));
  const at = n.updatedMs || n.createdMs;
  if (at) parts.push(relativeDate(now, at));
  return parts.join(' · ');
}

/** Where evidence came from: "said in session 4" when every session has a summary (exact
 *  numbering), else "said 2 days ago" for a summarised session (the procedure returns the last 5). */
export function sessionLabels(now: number, x: Pick<LearnerInsights, 'summaries' | 'learner'>): Map<string, string> {
  const newest = [...x.summaries].sort((a, b) => b.createdMs - a.createdMs);
  const exact = newest.length === x.learner.sessionCount;
  return new Map(newest.map((s, i) => [String(s.sessionId), exact ? `said in session ${newest.length - i}` : `said ${relativeDate(now, s.createdMs)}`]));
}

export interface EvidenceLine {
  quote: string;
  where: string;
}

/** The note's newest evidence quote with its source label ("said in an earlier session" if unknown). */
export function evidenceLine(n: InsightNote, labels: Map<string, string>): EvidenceLine | null {
  const e = n.evidence?.find(x => x.quote?.trim());
  if (!e) return null;
  return { quote: e.quote.trim().replace(/^["“]|["”]$/g, ''), where: labels.get(String(e.sessionId)) ?? 'said in an earlier session' };
}

// ------------------------------------------------------------------ mastery

export interface MasteryRow {
  concept: string;
  title: string;
  mastery: number;
  band: MasteryBand;
  updatedMs: number;
}
export interface MasteryGroup {
  category: string;
  title: string;
  rows: MasteryRow[];
}

/** Grouped by category title (alphabetical); inside, strongest first, then by title. */
export function masteryGroups(mastery: LearnerInsights['mastery']): MasteryGroup[] {
  const by = new Map<string, MasteryGroup>();
  for (const m of mastery) {
    const key = m.category || 'other';
    const g = by.get(key) ?? { category: key, title: m.categoryTitle || m.category || 'Other', rows: [] };
    const v = Math.max(0, Math.min(100, Math.round(m.mastery || 0)));
    g.rows.push({ concept: m.concept, title: m.title || m.concept, mastery: v, band: masteryBand(v), updatedMs: m.updatedMs });
    by.set(key, g);
  }
  const groups = [...by.values()];
  for (const g of groups) g.rows.sort((a, b) => b.mastery - a.mastery || a.title.localeCompare(b.title));
  return groups.sort((a, b) => a.title.localeCompare(b.title));
}

// ------------------------------------------------------------------ at a glance + next focus

function lc(title: string): string {
  // "What a fraction is" → "what a fraction is"; keep acronyms ("LCM") as they are
  return /^[A-Z][a-z]/.test(title) ? title[0]!.toLowerCase() + title.slice(1) : title;
}
function joinAnd(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
export function firstName(name: string): string {
  return (name || 'This student').trim().split(/\s+/)[0]!;
}

/** 1-2 plain sentences from the data, e.g. "Mia is secure with what a fraction is and still
 *  mixes up adding fractions with the same denominator. Wants a picture before any numbers." */
export function atAGlance(x: LearnerInsights): string {
  const who = firstName(x.learner.name);
  const strong = [...x.mastery].filter(m => m.mastery >= 60).sort((a, b) => b.mastery - a.mastery);
  const can = sortNotes(x.notes.filter(n => n.kind === 'understood' && n.conceptTitle));
  // up to two strengths: mastery ≥ 60 (strongest first), then concepts noted as understood
  const seen = new Set<string>();
  const top: { title: string; mastered: boolean }[] = [];
  for (const s of [...strong.map(m => ({ title: m.title, mastered: m.mastery >= 85 })), ...can.map(n => ({ title: n.conceptTitle, mastered: false }))]) {
    if (!s.title || seen.has(s.title) || top.length >= 2) continue;
    seen.add(s.title);
    top.push(s);
  }
  const mastered = top.filter(s => s.mastered).map(s => lc(s.title));
  const secure = top.filter(s => !s.mastered).map(s => lc(s.title));
  const parts = [mastered.length ? `has mastered ${joinAnd(mastered)}` : '', secure.length ? `is secure with ${joinAnd(secure)}` : ''].filter(Boolean);
  const mix = sortNotes(x.notes.filter(n => n.kind === 'misconception'));
  const mixTitle = mix.find(n => n.conceptTitle)?.conceptTitle;
  if (mixTitle) parts.push(`still mixes up ${lc(mixTitle)}`);

  let first = '';
  if (parts.length) first = `${who} ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]}.`;
  else if (mix[0]) first = `${who} still has a misconception: ${noteSentence(mix[0]).replace(/\.$/, '')}.`;
  else if (x.mastery.length) {
    const top = [...x.mastery].sort((a, b) => b.mastery - a.mastery)[0]!;
    const t = lc(top.title);
    first = masteryBand(top.mastery) === 'getting there' ? `${who} is getting there with ${t}.` : `${who} is just beginning with ${t}.`;
  }

  const helps = sortNotes(x.notes.filter(n => (n.kind === 'strategy' && n.outcome === 'worked') || n.kind === 'preference'));
  const second = helps[0] ? noteSentence(helps[0]) : '';

  const out = [first, second].filter(Boolean).join(' ');
  if (out) return out;
  return x.learner.sessionCount > 0 ? `The tutor has not noted anything about ${who} yet.` : `${who} has not practised with the tutor yet.`;
}

export interface NextFocus {
  text: string;
  fromMs: number;
}

/** The next focus written at the end of the latest session that has one. */
export function nextFocus(x: Pick<LearnerInsights, 'summaries'>): NextFocus | null {
  const s = [...x.summaries].sort((a, b) => b.createdMs - a.createdMs).find(s => s.nextFocus?.trim());
  return s ? { text: s.nextFocus.trim(), fromMs: s.createdMs } : null;
}

/** Past sessions, newest first. */
export function pastSessions(x: Pick<LearnerInsights, 'summaries'>): LearnerInsights['summaries'] {
  return [...x.summaries].sort((a, b) => b.createdMs - a.createdMs);
}

/** "4 sessions since Oct 3" / "No sessions yet". */
export function sessionsLine(x: LearnerInsights): string {
  const n = x.learner.sessionCount;
  if (!n) return 'No sessions yet';
  const since = x.learner.firstSeenMs ? ` since ${new Date(x.learner.firstSeenMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : '';
  return `${n} session${n === 1 ? '' : 's'}${since}`;
}

/** "Age 9 · Grade 4". Grade 0 is kindergarten. */
export function ageGrade(l: LearnerInsights['learner']): string {
  return [l.age ? `Age ${l.age}` : '', l.grade === 0 ? 'Kindergarten' : l.grade ? `Grade ${l.grade}` : ''].filter(Boolean).join(' · ');
}
