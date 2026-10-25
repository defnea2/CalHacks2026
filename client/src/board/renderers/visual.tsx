// `visual` kind: small SVG pictures. Sub-visual names live here, inside the board boundary.
import type { ReactNode } from 'react';
import type { RendererProps } from '../types';

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clampInt = (v: unknown, d: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(num(v, d))));

const STROKE = 'var(--foreground)';
const FILL = 'var(--chart-2)';
const MUTED = 'var(--muted)';

function NumberLine({ c }: { c: Record<string, unknown> }) {
  const min = num(c.min, 0);
  const max = num(c.max, 10) > min ? num(c.max, 10) : min + 1;
  const marks = Array.isArray(c.marks) ? (c.marks as unknown[]).filter((m): m is number => typeof m === 'number') : [];
  const ticks = marks.length ? marks : Array.from({ length: Math.min(21, Math.floor(max - min) + 1) }, (_, i) => min + ((max - min) * i) / Math.min(20, Math.floor(max - min) || 1));
  const W = 360;
  const x = (v: number) => 20 + ((v - min) / (max - min)) * (W - 40);
  const hl = typeof c.highlight === 'number' ? c.highlight : null;
  return (
    <svg viewBox={`0 0 ${W} 70`} className="w-full max-w-md" role="img" aria-label="number line">
      <line x1={10} y1={30} x2={W - 10} y2={30} stroke={STROKE} strokeWidth={2} />
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={x(t)} y1={22} x2={x(t)} y2={38} stroke={STROKE} strokeWidth={1.5} />
          <text x={x(t)} y={56} textAnchor="middle" fontSize={12} fill={STROKE}>
            {Number.isInteger(t) ? t : t.toFixed(2).replace(/0+$/, '')}
          </text>
        </g>
      ))}
      {hl !== null ? <circle cx={x(hl)} cy={30} r={7} fill={FILL} stroke={STROKE} /> : null}
    </svg>
  );
}

function FractionBar({ c }: { c: Record<string, unknown> }) {
  const parts = clampInt(c.parts, 4, 1, 48);
  const shaded = clampInt(c.shaded, 1, 0, parts);
  const W = 360;
  const w = (W - 4) / parts;
  return (
    <svg viewBox={`0 0 ${W} 60`} className="w-full max-w-md" role="img" aria-label={`${shaded} of ${parts}`}>
      {Array.from({ length: parts }, (_, i) => (
        <rect key={i} x={2 + i * w} y={2} width={w} height={40} fill={i < shaded ? FILL : MUTED} stroke={STROKE} strokeWidth={1.5} />
      ))}
      {c.label ? (
        <text x={W / 2} y={56} textAnchor="middle" fontSize={13} fill={STROKE}>
          {String(c.label)}
        </text>
      ) : null}
    </svg>
  );
}

function AreaGrid({ c }: { c: Record<string, unknown> }) {
  const rows = clampInt(c.rows, 3, 1, 20);
  const cols = clampInt(c.cols, 4, 1, 20);
  const shaded = clampInt(c.shaded, 0, 0, rows * cols);
  const s = Math.min(28, 300 / Math.max(rows, cols));
  return (
    <svg viewBox={`0 0 ${cols * s + 4} ${rows * s + 4}`} className="w-full max-w-xs" role="img" aria-label="area grid">
      {Array.from({ length: rows * cols }, (_, i) => (
        <rect
          key={i}
          x={2 + (i % cols) * s}
          y={2 + Math.floor(i / cols) * s}
          width={s}
          height={s}
          fill={i < shaded ? FILL : MUTED}
          stroke={STROKE}
          strokeWidth={1}
        />
      ))}
    </svg>
  );
}

function Groups({ c }: { c: Record<string, unknown> }) {
  const groups = clampInt(c.groups, 3, 1, 12);
  const per = clampInt(c.perGroup, 4, 1, 20);
  const item = typeof c.item === 'string' && c.item ? c.item : null;
  const cols = Math.ceil(Math.sqrt(per));
  const cell = 18;
  const gw = cols * cell + 16;
  const gh = Math.ceil(per / cols) * cell + 16;
  const perRow = Math.min(groups, 4);
  const W = perRow * (gw + 10);
  const H = Math.ceil(groups / perRow) * (gh + 10);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-md" role="img" aria-label={`${groups} groups of ${per}`}>
      {Array.from({ length: groups }, (_, g) => {
        const gx = (g % perRow) * (gw + 10) + 5;
        const gy = Math.floor(g / perRow) * (gh + 10) + 5;
        const items: ReactNode[] = Array.from({ length: per }, (_, i) => {
          const cx = gx + 8 + (i % cols) * cell + cell / 2;
          const cy = gy + 8 + Math.floor(i / cols) * cell + cell / 2;
          return item ? (
            <text key={i} x={cx} y={cy + 5} textAnchor="middle" fontSize={14}>
              {item}
            </text>
          ) : (
            <circle key={i} cx={cx} cy={cy} r={6} fill={FILL} stroke={STROKE} />
          );
        });
        return (
          <g key={g}>
            <rect x={gx} y={gy} width={gw} height={gh} rx={10} fill="none" stroke={STROKE} strokeDasharray="4 3" />
            {items}
          </g>
        );
      })}
    </svg>
  );
}

const VISUALS: Record<string, (p: { c: Record<string, unknown> }) => ReactNode> = {
  number_line: NumberLine,
  fraction_bar: FractionBar,
  area_grid: AreaGrid,
  groups: Groups,
};

export function VisualRenderer({ content }: RendererProps) {
  const V = VISUALS[String(content.visual)];
  return (
    <div className="flex flex-col items-center gap-2" data-visual={String(content.visual)}>
      {V ? <V c={content} /> : <pre className="text-xs text-muted-foreground">{JSON.stringify(content, null, 2)}</pre>}
      {content.caption ? <p className="text-sm text-muted-foreground">{String(content.caption)}</p> : null}
    </div>
  );
}
