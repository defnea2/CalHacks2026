// Fibonacci brand: the "01 Golden spiral" mark (quarter arcs through 8/5/3/2/1/1 squares) and the wordmark.
// Stroke weight and detail adapt to the rendered size so the spiral stays legible from 20 px to 280 px.

export const BRAND = {
  name: 'Fibonacci',
  navy: '#1B2340',
  navyHover: '#2E3A5C',
  gold: '#F5B83D',
  coral: '#EF6F5B',
  bg: '#F4F6FB',
  muted: '#4F586B',
} as const;

const FULL_PATH = 'M0 8A8 8 0 0 1 8 0A5 5 0 0 1 13 5A3 3 0 0 1 10 8A2 2 0 0 1 8 6A1 1 0 0 1 9 5A1 1 0 0 1 10 6';
const SHORT_PATH = 'M0 8A8 8 0 0 1 8 0A5 5 0 0 1 13 5A3 3 0 0 1 10 8';
const GRID: [number, number, number, number][] = [[0, 0, 8, 8], [8, 0, 5, 5], [10, 5, 3, 3], [8, 6, 2, 2], [8, 5, 1, 1], [9, 5, 1, 1]];

interface Variant { stroke: number; dot: number | null; path: string; grid: boolean }

/** Picks the drawing detail for a rendered size in CSS pixels. */
export function markVariant(size: number): Variant {
  if (size <= 24) return { stroke: 1.15, dot: null, path: SHORT_PATH, grid: false };
  if (size <= 40) return { stroke: 0.95, dot: null, path: FULL_PATH, grid: false };
  if (size <= 52) return { stroke: 0.85, dot: 0.6, path: FULL_PATH, grid: false };
  if (size < 100) return { stroke: 0.8, dot: 0.55, path: FULL_PATH, grid: false };
  return { stroke: 0.7, dot: 0.5, path: FULL_PATH, grid: true };
}

/** Standalone SVG markup (favicons, docs). */
export function markSvg(size: number): string {
  const v = markVariant(size);
  const grid = v.grid
    ? `<g stroke="#FFFFFF" stroke-opacity=".18" stroke-width=".08">${GRID.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`).join('')}</g>`
    : '';
  const dot = v.dot ? `<circle cx="10" cy="6" r="${v.dot}" fill="${BRAND.coral}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}"><rect width="100" height="100" rx="24" fill="${BRAND.navy}"/><g transform="translate(11.5 26.3) scale(5.92)" fill="none">${grid}<path d="${v.path}" stroke="${BRAND.gold}" stroke-width="${v.stroke}" stroke-linecap="round" stroke-linejoin="round"/>${dot}</g></svg>`;
}

export function LogoMark({ size = 32, title, className }: { size?: number; title?: string; className?: string }) {
  const v = markVariant(size);
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-testid="logo-mark"
      style={{ flex: 'none', display: 'block' }}
    >
      <rect width="100" height="100" rx="24" fill={BRAND.navy} />
      <g transform="translate(11.5 26.3) scale(5.92)" fill="none">
        {v.grid && (
          <g stroke="#FFFFFF" strokeOpacity={0.18} strokeWidth={0.08}>
            {GRID.map(([x, y, w, h]) => <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} />)}
          </g>
        )}
        <path d={v.path} stroke={BRAND.gold} strokeWidth={v.stroke} strokeLinecap="round" strokeLinejoin="round" />
        {v.dot && <circle cx="10" cy="6" r={v.dot} fill={BRAND.coral} />}
      </g>
    </svg>
  );
}

/** Mark + lowercase "fibonacci" in Fredoka 600. `size` is the text size; mark and gap scale from the 48/56/14 reference. */
export function Wordmark({ size = 48, className, mark: showMark = true }: { size?: number; className?: string; mark?: boolean }) {
  const mark = Math.round(size * (56 / 48));
  return (
    <span
      className={className}
      data-testid="wordmark"
      style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size * (14 / 48)) }}
    >
      {showMark && <LogoMark size={mark} />}
      <span
        style={{
          fontFamily: "'Fredoka', ui-rounded, system-ui, sans-serif",
          fontWeight: 600,
          fontSize: size,
          letterSpacing: size >= 32 ? -0.5 : -0.3,
          lineHeight: 1,
          color: BRAND.navy,
        }}
      >
        fibonacci
      </span>
    </span>
  );
}
