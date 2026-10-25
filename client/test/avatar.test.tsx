import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { TutorAvatar, micLevel } from '../src/components/TutorAvatar';

describe('tutor avatar', () => {
  it('exposes its state for styling and tests', () => {
    for (const state of ['idle', 'listening', 'thinking', 'speaking'] as const) {
      const html = renderToStaticMarkup(createElement(TutorAvatar, { state }));
      expect(html).toContain(`data-state="${state}"`);
      expect(html).toContain('data-testid="tutor-avatar"');
      expect(html).toContain('role="img"');
    }
    expect(renderToStaticMarkup(createElement(TutorAvatar, { state: 'thinking' }))).toContain('aria-label="Tutor is thinking"');
  });

  it('maps the microphone level (dBFS) to 0..1', () => {
    expect(micLevel(-100)).toBe(0);
    expect(micLevel(-62)).toBe(0);
    expect(micLevel(-41)).toBeCloseTo(0.5, 2);
    expect(micLevel(-20)).toBe(1);
    expect(micLevel(0)).toBe(1);
  });
});
