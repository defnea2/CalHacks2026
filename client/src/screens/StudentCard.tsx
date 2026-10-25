// Teacher dashboard student card: a small live chat window. Student bubbles left, tutor bubbles
// right, streaming in as `turn` / `reply_sentence` rows arrive (bubbles from lib/bubbles.ts).
// Resting: greyscale, semi-transparent, so the class overview stays calm. Hover / keyboard focus:
// the card clears up and shows Observe + Profile.
//
// Motion: the bubble stack is anchored at the bottom; when it grows (a new bubble, or a tutor
// bubble gaining a sentence) it is shifted back down by the growth and glides up (transform only,
// 250 ms, Web Animations). The top fades out under a mask. prefers-reduced-motion: no animation.
import { memo, useLayoutEffect, useRef } from 'react';
import type { Bubble } from '../lib/bubbles';
import { ObserveIcon, ProfileIcon } from '../brand/icons';
import { Initial } from './StudentHome';

export interface CardStudent {
  id: string;
  name: string;
  sessionId: string;
  stage: string;
  turnState: string;
}

function reducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function LiveChat({ bubbles }: { bubbles: Bubble[] }) {
  const stack = useRef<HTMLDivElement>(null);
  // Distance from the stack's bottom to the top of the previously newest bubble.
  const prev = useRef<{ key: string; fromBottom: number } | null>(null);
  useLayoutEffect(() => {
    const el = stack.current;
    if (!el) return;
    const last = el.lastElementChild as HTMLElement | null;
    const measure = (node: HTMLElement | null) => (node ? el.offsetHeight - node.offsetTop : 0);
    const before = prev.current;
    if (before && typeof el.animate === 'function' && !reducedMotion()) {
      const node = el.querySelector<HTMLElement>(`[data-key="${before.key}"]`);
      const shift = node ? measure(node) - before.fromBottom : 0;
      if (shift > 0.5) el.animate([{ transform: `translateY(${shift}px)` }, { transform: 'translateY(0)' }], { duration: 250, easing: 'cubic-bezier(.2,.75,.25,1)', composite: 'add' });
    }
    prev.current = last ? { key: last.dataset.key ?? '', fromBottom: measure(last) } : null;
  }, [bubbles]);

  return (
    <div className="db-chat" data-testid="student-chat" aria-live="off">
      {bubbles.length === 0 ? (
        <p className="db-chat-empty">Getting started…</p>
      ) : (
        <div className="db-bubbles" ref={stack}>
          {bubbles.map(b => (
            <p key={b.key} data-key={b.key} data-testid="chat-bubble" data-who={b.who} className={`db-bubble db-bubble-${b.who}${b.live ? ' db-bubble-live' : ''}`}>
              <span>{b.text}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export const StudentCard = memo(function StudentCard({ bubbles, cluster, onObserve, onProfile, ...s }: CardStudent & { bubbles: Bubble[]; cluster?: string; onObserve: (id: string) => void; onProfile: (id: string) => void }) {
  return (
    <article className="db-card" data-testid="student-card" data-learner-id={s.id} data-session-id={s.sessionId} data-cluster={cluster ?? ''} tabIndex={0} aria-label={`${s.name}, ${s.stage}`}>
      <div className="db-card-top">
        <Initial name={s.name} />
        <strong>{s.name}</strong>
        <span className="db-turn" data-state={s.turnState} title={s.turnState} />
        <span className="db-stage" data-testid="student-stage">{s.stage}</span>
      </div>
      <LiveChat bubbles={bubbles} />
      <div className="db-card-actions">
        <button className="db-action db-action-observe" data-testid="observe-student" data-learner-id={s.id} onClick={() => onObserve(s.id)} aria-label={`Observe ${s.name}`}>
          <ObserveIcon size={22} />
          <span>Observe</span>
        </button>
        <button className="db-action db-action-profile" data-testid="open-profile" data-learner-id={s.id} onClick={() => onProfile(s.id)} aria-label={`Profile of ${s.name}`}>
          <ProfileIcon size={22} />
          <span>Profile</span>
        </button>
      </div>
    </article>
  );
});
