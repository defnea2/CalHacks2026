// Fibonacci icons: hand-drawn inline SVGs in the logo's line style (simple strokes, round caps and
// joins, ~1.8 px at 24 px), greyscale ink. No icon library. Colour follows `currentColor`, so a
// button decides the grey; the default ink is the brand navy.
import type { ReactNode, SVGProps } from 'react';

export const ICON_INK = '#1B2340';

type IconProps = { size?: number; title?: string; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, 'children'>;

function Svg({ size = 20, title, strokeWidth = 1.8, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      style={{ flex: 'none', display: 'block' }}
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Observe: an almond eye whose iris is a small golden spiral (quarter arcs 0.4 → 2.75, Fibonacci ratios, like the mark). */
export function ObserveIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.6 12.2C5 8 8.2 5.9 12 5.9s7 2.1 9.4 6.3C19 16.4 15.8 18.5 12 18.5s-7-2.1-9.4-6.3Z" />
      <path d="M11.1 12.5a.4.4 0 0 1 .4.4a.65.65 0 0 1-.65.65a1.05 1.05 0 0 1-1.05-1.05a1.7 1.7 0 0 1 1.7-1.7a2.75 2.75 0 0 1 2.75 2.75" />
    </Svg>
  );
}

/** Profile: a notebook with a ring binding and a person on its cover. */
export function ProfileIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="5.5" y="3" width="14" height="18" rx="2.6" />
      <path d="M3.6 7.6h3.4M3.6 12h3.4M3.6 16.4h3.4" />
      <circle cx="12.9" cy="10" r="2.5" />
      <path d="M8.9 17.3c.8-2.1 2.2-3.2 4-3.2s3.2 1.1 4 3.2" />
    </Svg>
  );
}

/** Previous student. */
export function PrevIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14.5 6.5L9 12l5.5 5.5" />
    </Svg>
  );
}

/** Next student. */
export function NextIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.5 6.5L15 12l-5.5 5.5" />
    </Svg>
  );
}

/** Stop observing: a closed eye (the observe eye with its lid down). */
export function StopIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.6 10.4C5 14.3 8.2 16.2 12 16.2s7-1.9 9.4-5.8" />
      <path d="M5.2 13.9l-1.5 1.9M9.3 15.8l-.6 2.3M14.7 15.8l.6 2.3M18.8 13.9l1.5 1.9" />
    </Svg>
  );
}

/** Close (drawer). */
export function CloseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </Svg>
  );
}

/** All icons by name (preview sheet, tests). */
export const ICONS = { observe: ObserveIcon, profile: ProfileIcon, prev: PrevIcon, next: NextIcon, stop: StopIcon, close: CloseIcon } as const;
