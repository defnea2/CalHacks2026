// The tutor's face: a small round character drawn in SVG (own artwork, no external assets).
// It shows what the tutor is doing:
//   idle      – breathes slowly, blinks
//   listening – a halo follows the learner's microphone level, the eyes open wide
//   thinking  – the eyes look up, three dots pulse beside it (session.turnState = thinking)
//   speaking  – the mouth opens with the playback amplitude (text mode: a gentle synthetic rhythm)
// The level is read per animation frame from `level()` and written to the CSS variable --lv,
// so the avatar animates without React renders. Reduced motion: only the state changes show.
import { useEffect, useRef } from 'react';

export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface TutorAvatarProps {
  state: AvatarState;
  /** 0..1, read every frame while listening/speaking. Omitted while speaking → synthetic rhythm. */
  level?: () => number;
  size?: number;
  label?: string;
}

export function TutorAvatar({ state, level, size = 56, label }: TutorAvatarProps) {
  const el = useRef<HTMLDivElement>(null);
  const levelRef = useRef(level);
  levelRef.current = level;

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    if (state !== 'listening' && state !== 'speaking') {
      node.style.setProperty('--lv', '0');
      return;
    }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let smooth = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const src = levelRef.current;
      let v = src ? src() : 0;
      // Text mode (no audio): a soft talking rhythm while the tutor's words appear.
      if (!src && state === 'speaking') v = 0.35 + 0.3 * Math.abs(Math.sin((now - t0) / 140)) * (0.6 + 0.4 * Math.sin((now - t0) / 530));
      smooth += (v - smooth) * (v > smooth ? 0.5 : 0.18);
      node.style.setProperty('--lv', reduced ? '0' : smooth.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  return (
    <div
      ref={el}
      className="tf-avatar"
      data-testid="tutor-avatar"
      data-state={state}
      style={{ width: size, height: size }}
      role="img"
      aria-label={label ?? `Tutor is ${state === 'idle' ? 'here' : state}`}
    >
      <span className="tf-halo" aria-hidden="true" />
      <svg viewBox="0 0 100 100" aria-hidden="true">
        {/* sprout */}
        <path className="tf-sprout" d="M50 16 C50 9 54 5 60 4 C60 10 56 14 50 16 Z M50 16 C49 11 45 8 40 8 C41 13 45 16 50 16 Z" />
        <circle className="tf-body" cx="50" cy="56" r="38" />
        <circle className="tf-cheek" cx="27" cy="66" r="5" />
        <circle className="tf-cheek" cx="73" cy="66" r="5" />
        <g className="tf-eyes">
          <ellipse className="tf-eye" cx="37" cy="51" rx="5" ry="6.5" />
          <ellipse className="tf-eye" cx="63" cy="51" rx="5" ry="6.5" />
        </g>
        <path className="tf-smile" d="M39 67 Q50 76 61 67" />
        <ellipse className="tf-mouth" cx="50" cy="69" rx="10" ry="8" />
      </svg>
      <span className="tf-dots" aria-hidden="true"><i /><i /><i /></span>
    </div>
  );
}

/** Microphone level in dBFS → 0..1 for the avatar halo and the learner meter. */
export function micLevel(db: number): number {
  return Math.max(0, Math.min(1, (db + 62) / 42));
}
