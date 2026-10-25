// Labels from the lesson pack (no phase ids in client code) and time helpers.
import { getPhase, pack } from '@tutor/shared';

export function phaseLabel(phase: string): string {
  if (!phase) return '—';
  return getPhase(pack, phase)?.label ?? phase;
}

export function topicLabel(category: string, concept: string): string {
  if (!category) return 'Not set yet';
  const cat = pack.taxonomy.find(c => c.key === category);
  const con = cat?.concepts.find(k => k.key === concept);
  return [cat?.title ?? category, concept ? (con?.title ?? concept) : ''].filter(Boolean).join(' · ');
}

interface TimestampLike {
  microsSinceUnixEpoch: bigint;
}

export function tsMs(t: TimestampLike | undefined | null): number | null {
  if (!t) return null;
  return Number(t.microsSinceUnixEpoch / 1000n);
}

/** b - a in ms, or null. */
export function diffMs(a: TimestampLike | undefined | null, b: TimestampLike | undefined | null): number | null {
  const x = tsMs(a);
  const y = tsMs(b);
  return x === null || y === null ? null : y - x;
}

export function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export function sessionUrl(kind: 'session' | 'observe', id: bigint | string): string {
  const p = new URLSearchParams(window.location.search);
  p.delete('session');
  p.delete('observe');
  p.delete('overview');
  p.set(kind, id.toString());
  return `${window.location.pathname}?${p.toString()}`;
}

export function homeUrl(extra?: string): string {
  const p = new URLSearchParams(window.location.search);
  p.delete('session');
  p.delete('observe');
  p.delete('overview');
  if (extra) p.set(extra, '');
  const s = p.toString().replace(/=$|=(?=&)/g, '');
  return `${window.location.pathname}${s ? `?${s}` : ''}`;
}

/** Client-side navigation within the tab (keeps the connection). */
export function navigate(url: string) {
  window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
