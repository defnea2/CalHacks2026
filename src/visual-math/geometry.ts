export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function reorderObject(order: string[], from: string, to: string): string[] {
  const start = order.indexOf(from), end = order.indexOf(to);
  if (start < 0 || end < 0 || start === end) return [...order];
  const next = [...order]; next.splice(start, 1); next.splice(end, 0, from);
  return next;
}

export function tickValues(min: number, max: number): number[] {
  const count = Math.min(10, Math.max(1, Math.ceil(max - min)));
  return Array.from({ length: count + 1 }, (_, i) => Number((min + (max - min) * i / count).toFixed(4)));
}

export function valueFromPosition(x: number, left: number, width: number, min: number, max: number): number {
  if (!Number.isFinite(width) || width <= 0 || min >= max) throw new Error('Invalid number line bounds.');
  const value = min + clamp((x - left) / width, 0, 1) * (max - min);
  const step = max - min > 2 ? 1 : 0.1;
  return Number(clamp(min + Math.round((value - min) / step) * step, min, max).toFixed(4));
}

export function diagramLayout(order: string[], columns: number) {
  const rows = Math.ceil(order.length / columns), height = rows * 175 + 40;
  return {
    height,
    positions: Object.fromEntries(order.map((id, i) => [id, { x: (i % columns + 0.5) * 1000 / columns, y: Math.floor(i / columns) * 175 + 105 }])),
  };
}

export function connectionPath(from: { x: number; y: number }, to: { x: number; y: number }, halfWidth: number, halfHeight: number): string {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (dx === 0 && dy === 0) return '';
  const scale = Math.min(dx === 0 ? Infinity : halfWidth / Math.abs(dx), dy === 0 ? Infinity : halfHeight / Math.abs(dy));
  const start = { x: from.x + dx * scale, y: from.y + dy * scale };
  const end = { x: to.x - dx * scale, y: to.y - dy * scale };
  return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
}
