import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ageGrade,
  atAGlance,
  confidenceWord,
  errorText,
  evidenceLine,
  masteryBand,
  masteryGroups,
  nextFocus,
  noteMeta,
  noteSections,
  noteSentence,
  parseInsights,
  pastSessions,
  relativeDate,
  seenLabel,
  sessionLabels,
  sessionsLine,
} from '../src/lib/insights';
import { emptyInsightsFixture, insightsFixture } from '../src/insights/fixture';

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const H = 3_600_000;
const D = 24 * H;
const fx = () => insightsFixture(NOW);

describe('words for numbers', () => {
  it('relative dates', () => {
    expect(relativeDate(NOW, NOW - 10_000)).toBe('just now');
    expect(relativeDate(NOW, NOW - 60_000)).toBe('1 minute ago');
    expect(relativeDate(NOW, NOW - 5 * 60_000)).toBe('5 minutes ago');
    expect(relativeDate(NOW, NOW - 3 * H)).toBe('3 hours ago');
    expect(relativeDate(NOW, NOW - D - H)).toBe('yesterday');
    expect(relativeDate(NOW, NOW - 2 * D)).toBe('2 days ago');
    expect(relativeDate(NOW, NOW - 20 * D)).toBe('2 weeks ago');
    expect(relativeDate(NOW, NOW - 100 * D)).toMatch(/2026/);
    expect(relativeDate(NOW, NOW + 5000)).toBe('just now');
  });

  it('confidence and reinforcement as words', () => {
    expect(confidenceWord(0.95)).toBe('clearly');
    expect(confidenceWord(0.85)).toBe('clearly');
    expect(confidenceWord(0.7)).toBe('likely');
    expect(confidenceWord(0.5)).toBe('maybe');
    expect(seenLabel(0)).toBe('seen once');
    expect(seenLabel(1)).toBe('seen twice');
    expect(seenLabel(2)).toBe('seen 3 times');
  });

  it('mastery bands', () => {
    expect([0, 1, 29, 30, 59, 60, 84, 85, 100, 150, -3].map(masteryBand)).toEqual([
      'not started', 'beginning', 'beginning', 'getting there', 'getting there', 'secure', 'secure', 'mastered', 'mastered', 'mastered', 'not started',
    ]);
  });
});

describe('sections in teacher language', () => {
  it('groups notes by kind and outcome, fixed order, empty sections dropped', () => {
    const s = noteSections(fx().notes);
    expect(s.map(x => x.title)).toEqual(['Still mixing up', 'What helps', "What didn't help", 'Memory aids', 'Can do now', 'In their own words']);
    const helps = s.find(x => x.key === 'helps')!;
    expect(helps.notes.map(n => n.kind).sort()).toEqual(['preference', 'strategy']);
    expect(s.find(x => x.key === 'didnt')!.notes.map(n => n.id)).toEqual(['n4']);
    expect(noteSections([]).length).toBe(0);
  });

  it('strongest notes first (confidence x sightings)', () => {
    const mixing = noteSections(fx().notes).find(x => x.key === 'mixing')!;
    expect(mixing.notes.map(n => n.id)).toEqual(['n1', 'n2']);
  });

  it('note sentences and meta', () => {
    const notes = fx().notes;
    const q = notes.find(n => n.kind === 'quote')!;
    expect(noteSentence(q)).toBe('“so the bottom is how many slices the pizza has”');
    expect(noteSentence({ ...notes[0]!, text: 'mixes tops and bottoms' })).toBe('Mixes tops and bottoms.');
    expect(noteMeta(NOW, notes[0]!)).toBe('clearly · seen 3 times · 2 hours ago');
    expect(noteMeta(NOW, q)).not.toMatch(/clearly|likely/);
    expect(noteMeta(NOW, notes[1]!)).toBe('likely'); // seeded, never reinforced
    expect(noteMeta(NOW, { ...notes[1]!, reinforced: 1 })).toBe('likely · seen twice · 9 days ago');
  });

  it('evidence: "said in session N" with exact numbering, else relative date', () => {
    const x = fx();
    const labels = sessionLabels(NOW, x);
    expect(evidenceLine(x.notes[0]!, labels)).toEqual({ quote: 'one quarter plus two quarters is three eighths', where: 'said in session 3' });
    expect(evidenceLine(x.notes[1]!, labels)).toBeNull();
    const partial = sessionLabels(NOW, { ...x, learner: { ...x.learner, sessionCount: 12 } });
    expect(evidenceLine(x.notes[2]!, partial)!.where).toBe('said 3 days ago');
    expect(evidenceLine({ ...x.notes[0]!, evidence: [{ sessionId: '999', fromTurn: 0, toTurn: 1, quote: '"hi"' }] }, labels)).toEqual({ quote: 'hi', where: 'said in an earlier session' });
  });
});

describe('mastery', () => {
  it('grouped by category title, strongest first', () => {
    const g = masteryGroups(fx().mastery);
    expect(g.map(x => x.title)).toEqual(['Fractions', 'Multiplying and dividing']);
    expect(g[0]!.rows.map(r => [r.mastery, r.band])).toEqual([
      [72, 'secure'],
      [40, 'getting there'],
      [25, 'beginning'],
    ]);
  });
});

describe('at a glance + next focus', () => {
  it('builds the summary deterministically from the data', () => {
    expect(atAGlance(fx())).toBe('Mia has mastered multiplication as equal groups, is secure with what a fraction is and still mixes up adding fractions with the same denominator. Wants a picture before any numbers.');
    expect(atAGlance(fx())).toBe(atAGlance(fx()));
  });

  it('secure wording, misconception-only and empty learners', () => {
    const x = fx();
    const secure = { ...x, mastery: x.mastery.filter(m => m.mastery < 85) };
    expect(atAGlance(secure)).toMatch(/^Mia is secure with what a fraction is and still mixes up adding fractions/);
    const onlyMix = { ...x, mastery: [], notes: x.notes.filter(n => n.kind === 'misconception') };
    expect(atAGlance(onlyMix)).toBe('Mia still mixes up adding fractions with the same denominator.');
    expect(atAGlance(emptyInsightsFixture(NOW))).toBe('Ava has not practised with the tutor yet.');
    const e = emptyInsightsFixture(NOW);
    expect(atAGlance({ ...e, learner: { ...e.learner, sessionCount: 1 } })).toBe('The tutor has not noted anything about Ava yet.');
    expect(atAGlance({ ...e, mastery: [{ concept: 'c', title: 'Place value', category: 'numbers', categoryTitle: 'Numbers', mastery: 40, updatedMs: NOW }] })).toBe('Ava is getting there with place value.');
  });

  it('next focus from the latest summary that has one; sessions newest first', () => {
    const x = fx();
    expect(nextFocus(x)!.text).toMatch(/^Adding fractions/);
    expect(nextFocus({ summaries: x.summaries.map(s => (s.sessionId === '103' ? { ...s, nextFocus: '' } : s)) })!.text).toBe('Try adding two fractions with the same denominator.');
    expect(nextFocus({ summaries: [] })).toBeNull();
    expect(pastSessions({ summaries: [...x.summaries].reverse() }).map(s => s.sessionId)).toEqual(['103', '102', '101']);
  });

  it('header lines', () => {
    expect(sessionsLine(fx())).toMatch(/^3 sessions since Oct \d+$/);
    expect(sessionsLine(emptyInsightsFixture(NOW))).toBe('No sessions yet');
    const seededSummary = { ...emptyInsightsFixture(NOW), summaries: fx().summaries.slice(0, 1) };
    expect(sessionsLine(seededSummary)).toMatch(/^1 session since/);
    expect(ageGrade(fx().learner)).toBe('Age 9 · Grade 4');
    expect(ageGrade({ ...fx().learner, grade: 0 })).toBe('Age 9 · Kindergarten');
  });
});

describe('parsing and errors', () => {
  it('parses ok and error results, rejects junk', () => {
    const ok = parseInsights(JSON.stringify(fx()));
    expect(ok.ok).toBe(true);
    expect(parseInsights('{"ok":false,"error":"locked"}')).toEqual({ ok: false, error: 'locked' });
    expect(parseInsights('nope')).toEqual({ ok: false, error: 'bad_response' });
    expect(parseInsights('')).toEqual({ ok: false, error: 'bad_response' });
  });

  it('plain words for every error', () => {
    for (const e of ['unknown_teacher', 'locked', 'unknown_learner', 'bad_response', 'boom']) {
      expect(errorText(e)).not.toMatch(/_/);
    }
    expect(errorText('locked')).toMatch(/key/);
  });
});

describe('privacy guard: student screens never touch the profile', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  const files = [...walk(join(src, 'session')), ...['StudentHome.tsx', 'WaitingRoom.tsx', 'SessionScreen.tsx'].map(f => join(src, 'screens', f))];

  it('covers the student files', () => {
    expect(files.length).toBeGreaterThan(4);
  });

  it.each(files.map(f => [f.slice(src.length + 1), f]))('%s', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/insights\//);
    expect(text).not.toMatch(/learnerInsights/);
    expect(text).not.toMatch(/lib\/insights/);
  });
});
