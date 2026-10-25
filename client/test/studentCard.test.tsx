import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudentCard } from '../src/screens/StudentCard';
import { ICONS } from '../src/brand/icons';

const noop = () => undefined;
const card = (bubbles = [{ key: 's0', who: 'student' as const, text: 'Is it 3/4?', live: false }, { key: 'u1', who: 'tutor' as const, text: 'Yes. Why?', live: true }]) =>
  renderToStaticMarkup(createElement(StudentCard, { id: '7', name: 'Mia Chen', sessionId: '42', stage: 'Try this', turnState: 'speaking', bubbles, onObserve: noop, onProfile: noop }));

describe('dashboard student card', () => {
  it('renders a live chat: student bubbles left, tutor bubbles right', () => {
    const html = card();
    expect(html).toContain('data-testid="student-chat"');
    expect(html).toMatch(/data-who="student"[^>]*class="db-bubble db-bubble-student"/);
    expect(html).toMatch(/data-who="tutor"[^>]*class="db-bubble db-bubble-tutor db-bubble-live"/);
    expect(html.indexOf('Is it 3/4?')).toBeLessThan(html.indexOf('Yes. Why?'));
  });

  it('hover/focus actions: Observe and Profile buttons with the custom icons (no old small links)', () => {
    const html = card();
    expect(html).toContain('tabindex="0"'); // keyboard focus reveals the actions (:focus-within)
    expect(html).toMatch(/<button class="db-action db-action-observe" data-testid="observe-student" data-learner-id="7"[^>]*><svg[^>]*stroke-linecap="round"[^>]*>.*?<\/svg><span>Observe<\/span><\/button>/);
    expect(html).toMatch(/<button class="db-action db-action-profile" data-testid="open-profile" data-learner-id="7"[^>]*><svg[^>]*>.*?<\/svg><span>Profile<\/span><\/button>/);
    expect(html).not.toContain('pr-secondary db-profile');
    expect(html.match(/<button/g)).toHaveLength(2);
  });

  it('empty chat says getting started', () => {
    expect(card([])).toContain('Getting started');
  });

  it('every icon is an inline greyscale stroke drawing (currentColor, round caps)', () => {
    for (const [name, Icon] of Object.entries(ICONS)) {
      const svg = renderToStaticMarkup(createElement(Icon, {}));
      expect(svg, name).toContain('stroke="currentColor"');
      expect(svg, name).toContain('stroke-linejoin="round"');
      expect(svg, name).toContain('aria-hidden="true"');
    }
  });
});
