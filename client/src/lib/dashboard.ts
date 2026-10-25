// Teacher dashboard: pure layout and navigation helpers (unit-tested in test/dashboard.test.ts).
//
// Layout rule (user spec): four student cards per row. A cluster has exactly 2 or 4 students,
// so a row holds one cluster of 4 or two clusters of 2. The module's only arithmetic exceptions
// (an odd class: one cluster of 3; a class of one: a cluster of 1) take the slots of a 4 / a 2.

export interface ClusterIn {
  id: string;
  position: number;
  name: string;
  description: string;
  learnerIds: string[];
}

export interface ClusterBlock extends ClusterIn {
  /** Card columns this cluster takes in its row (2 or 4). */
  slots: 2 | 4;
}

export const ROW_SLOTS = 4;

export function clusterSlots(size: number): 2 | 4 {
  return size <= 2 ? 2 : 4;
}

/** student_cluster.learnerIds: JSON string[] (u64 as strings). Never throws. */
/** Learner ids of a student_cluster row: the typed `members` column, or the JSON `learnerIds`
 *  string of a row from an older module (members empty or missing). */
export function clusterMemberIds(c: { learnerIds: string; members?: readonly bigint[] }): string[] {
  return c.members && c.members.length ? c.members.map(String) : parseLearnerIds(c.learnerIds);
}

export function parseLearnerIds(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.map(x => String(x)).filter(x => /^\d+$/.test(x)) : [];
  } catch {
    return [];
  }
}

/**
 * Rows of clusters in position order. A 4 fills its own row; a 2 waits for the next 2 to share
 * a row (so a 2 followed by a 4 never leaves a half-empty row in the middle). At most one row
 * (the one holding the last unpaired 2) is half full.
 */
export function clusterRows(clusters: ClusterIn[]): ClusterBlock[][] {
  const rows: ClusterBlock[][] = [];
  let half: number | null = null;
  for (const c of [...clusters].sort((a, b) => a.position - b.position)) {
    const block: ClusterBlock = { ...c, slots: clusterSlots(c.learnerIds.length) };
    if (block.slots === ROW_SLOTS) rows.push([block]);
    else if (half !== null) {
      rows[half]!.push(block);
      half = null;
    } else {
      rows.push([block]);
      half = rows.length - 1;
    }
  }
  return rows;
}

/** Dashboard order of students: cluster rows left to right, top to bottom, then the ungrouped ones. */
export function observeOrder(rows: ClusterBlock[][], ungrouped: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...rows.flat().flatMap(c => c.learnerIds), ...ungrouped]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Previous (-1) / next (+1) student in dashboard order, wrapping around. */
export function stepObserve(order: string[], current: string, delta: -1 | 1): string | null {
  if (order.length === 0) return null;
  const i = order.indexOf(current);
  if (i < 0) return order[0]!;
  return order[(i + delta + order.length) % order.length]!;
}

/** Students of the class that no cluster names yet (before the first summary, or new joiners). */
export function ungroupedIds(all: string[], rows: ClusterBlock[][]): string[] {
  const grouped = new Set(rows.flat().flatMap(c => c.learnerIds));
  return all.filter(id => !grouped.has(id));
}

/** "updated 12 s ago" — the dashboard's freshness line. */
export function agoLabel(nowMs: number, thenMs: number | null): string {
  if (thenMs === null) return 'not yet';
  const s = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

export interface RefreshInfo {
  running: boolean;
  impersonating: boolean;
  nextDueMs: number | null;
  lastError: string;
}

/** Second part of the freshness line: what happens next. */
export function nextLabel(nowMs: number, r: RefreshInfo): string {
  if (r.running) return 'updating…';
  if (r.impersonating) return 'paused while you observe';
  if (r.lastError) return 'last update failed, retrying';
  if (r.nextDueMs === null) return '';
  const s = Math.ceil((r.nextDueMs - nowMs) / 1000);
  return s <= 0 ? 'next update now' : `next in ${s} s`;
}

/** refreshDashboard returns a typed object; a module published before that returned a JSON string. */
export function refreshResult(out: unknown): { ok: boolean; skipped: string; error: string } {
  const r = (typeof out === 'string' ? JSON.parse(out || '{}') : (out ?? {})) as { ok?: boolean; skipped?: string; error?: string };
  return { ok: !!r.ok, skipped: r.skipped ?? '', error: r.error ?? '' };
}
