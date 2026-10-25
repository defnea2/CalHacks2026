// Guard: the student UI is voice only (no text mode). The backend text path (submitTextTurn,
// setSessionVoice) stays for simulated students and harnesses, but no student screen may offer it.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../src');
const STUDENT_FILES = [
  ...readdirSync(join(SRC, 'screens')).filter(f => /^(Entry|StudentHome|WaitingRoom|SessionScreen|MicCheck)\.tsx$/.test(f)).map(f => join(SRC, 'screens', f)),
  join(SRC, 'session/SessionView.tsx'),
];

const FORBIDDEN: [RegExp, string][] = [
  [/Type instead/i, '"Type instead of talking" control'],
  [/data-testid="text-(input|mode|form|send)"/, 'text-mode test ids'],
  [/get\('voice'\)/, '?voice=0 flag'],
  [/setSessionVoice/, 'switching a session to text mode'],
  [/<textarea(?![^>]*task-text)/, 'free-text answer box'],
  [/data-testid="(start-talking|welcome-start)"/, 'separate "Start talking" step'],
  [/type it|or type|Talk or type/i, 'typing copy'],
];

describe('student UI is voice only', () => {
  it('finds the student screens', () => {
    expect(STUDENT_FILES.length).toBeGreaterThanOrEqual(5);
  });
  for (const f of STUDENT_FILES) {
    it(f.slice(SRC.length + 1), () => {
      const src = readFileSync(f, 'utf8');
      for (const [re, what] of FORBIDDEN) expect(re.test(src), `${what} in ${f}`).toBe(false);
    });
  }
  it('session view starts voice automatically and offers mute + sound settings', () => {
    const src = readFileSync(join(SRC, 'session/SessionView.tsx'), 'utf8');
    expect(src).toMatch(/ui\.voice_autostart/);
    expect(src).toMatch(/data-testid="mic-mute"/);
    expect(src).toMatch(/<AudioSettings/);
    expect(src).toMatch(/data-testid="mic-retry"/);
  });
});
