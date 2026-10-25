import { describe, expect, it } from 'vitest';
import { agoLabel, clusterRows, clusterSlots, nextLabel, observeOrder, parseLearnerIds, refreshResult, ROW_SLOTS, stepObserve, ungroupedIds, type ClusterIn } from '../src/lib/dashboard';

let n = 0;
const cl = (size: number, position = n): ClusterIn => {
  n += 1;
  return { id: `c${n}`, position, name: `C${n}`, description: '', learnerIds: Array.from({ length: size }, (_, i) => `${n * 100 + i}`) };
};
const sizes = (rows: ReturnType<typeof clusterRows>) => rows.map(r => r.map(c => c.learnerIds.length));
const slots = (rows: ReturnType<typeof clusterRows>) => rows.map(r => r.reduce((s, c) => s + c.slots, 0));

describe('cluster grid layout (four students per row)', () => {
  it('maps cluster sizes to card slots', () => {
    expect([1, 2, 3, 4].map(clusterSlots)).toEqual([2, 2, 4, 4]);
  });

  it('one cluster of 4 or two clusters of 2 per row', () => {
    const rows = clusterRows([cl(4, 0), cl(2, 1), cl(2, 2), cl(4, 3)]);
    expect(sizes(rows)).toEqual([[4], [2, 2], [4]]);
    expect(slots(rows).every(s => s === ROW_SLOTS)).toBe(true);
  });

  it('a 2 waits for the next 2 instead of leaving a half row before a 4', () => {
    expect(sizes(clusterRows([cl(2, 0), cl(4, 1), cl(2, 2)]))).toEqual([[2, 2], [4]]);
  });

  it('keeps at most one half-full row (an unpaired 2) for every combination up to 20 students', () => {
    // Every split of up to 20 students into 2s and 4s, in several orders.
    for (let fours = 0; fours <= 5; fours++) {
      for (let twos = 0; fours * 4 + twos * 2 <= 20; twos++) {
        const list = [...Array(fours).fill(4), ...Array(twos).fill(2)];
        for (const order of [list, [...list].reverse(), list.filter((_, i) => i % 2 === 0).concat(list.filter((_, i) => i % 2 === 1))]) {
          const rows = clusterRows(order.map((s, i) => cl(s, i)));
          const sl = slots(rows);
          expect(sl.every(s => s <= ROW_SLOTS)).toBe(true);
          expect(sl.filter(s => s < ROW_SLOTS).length).toBe(twos % 2);
          expect(rows.flat().length).toBe(order.length);
          expect(rows.every(r => r.length === 1 ? r[0]!.slots === 4 || r[0]!.slots === 2 : r.length === 2 && r.every(c => c.slots === 2))).toBe(true);
        }
      }
    }
  });

  it('the odd-class exception (one cluster of 3) takes a full row', () => {
    const rows = clusterRows([cl(2, 0), cl(3, 1), cl(2, 2)]);
    expect(sizes(rows)).toEqual([[2, 2], [3]]);
    expect(rows[1]![0]!.slots).toBe(4);
  });

  it('orders by position, not by array order', () => {
    const a = cl(4, 2);
    const b = cl(4, 0);
    expect(clusterRows([a, b]).map(r => r[0]!.id)).toEqual([b.id, a.id]);
  });

  it('parses learner ids defensively', () => {
    expect(parseLearnerIds('["1","2",3]')).toEqual(['1', '2', '3']);
    expect(parseLearnerIds('nope')).toEqual([]);
    expect(parseLearnerIds('{"a":1}')).toEqual([]);
    expect(parseLearnerIds('["x","4"]')).toEqual(['4']);
  });
});

describe('observe: previous / next in dashboard order', () => {
  const rows = clusterRows([
    { id: 'a', position: 0, name: 'A', description: '', learnerIds: ['1', '2'] },
    { id: 'b', position: 1, name: 'B', description: '', learnerIds: ['3', '4', '5', '6'] },
    { id: 'c', position: 2, name: 'C', description: '', learnerIds: ['7', '8'] },
  ]);
  const order = observeOrder(rows, ungroupedIds(['1', '2', '3', '4', '5', '6', '7', '8', '9'], rows));

  it('follows the rows left to right, then the ungrouped students', () => {
    // a and c share the first row; b fills the second
    expect(order).toEqual(['1', '2', '7', '8', '3', '4', '5', '6', '9']);
  });

  it('wraps around both ways', () => {
    expect(stepObserve(order, '2', 1)).toBe('7');
    expect(stepObserve(order, '9', 1)).toBe('1');
    expect(stepObserve(order, '1', -1)).toBe('9');
    expect(stepObserve(order, '3', -1)).toBe('8');
  });

  it('falls back to the first student and handles an empty class', () => {
    expect(stepObserve(order, '42', 1)).toBe('1');
    expect(stepObserve([], '1', 1)).toBeNull();
    expect(stepObserve(['5'], '5', 1)).toBe('5');
  });

  it('lists a student only once', () => {
    expect(observeOrder(rows, ['1', '9'])).toEqual(['1', '2', '7', '8', '3', '4', '5', '6', '9']);
  });
});

describe('dashboard timers', () => {
  const now = 1_000_000;
  it('shows how old the summary is', () => {
    expect(agoLabel(now, null)).toBe('not yet');
    expect(agoLabel(now, now - 500)).toBe('just now');
    expect(agoLabel(now, now - 12_400)).toBe('12 s ago');
    expect(agoLabel(now, now - 59_999)).toBe('59 s ago');
    expect(agoLabel(now, now - 61_000)).toBe('1 min ago');
    expect(agoLabel(now, now - 2 * 3600_000)).toBe('2 h ago');
    expect(agoLabel(now, now + 3000)).toBe('just now'); // clock skew
  });

  it('says what happens next', () => {
    const base = { running: false, impersonating: false, nextDueMs: now + 17_200, lastError: '' };
    expect(nextLabel(now, base)).toBe('next in 18 s');
    expect(nextLabel(now, { ...base, nextDueMs: now - 1 })).toBe('next update now');
    expect(nextLabel(now, { ...base, running: true })).toBe('updating…');
    expect(nextLabel(now, { ...base, impersonating: true })).toBe('paused while you observe');
    expect(nextLabel(now, { ...base, lastError: 'http 529' })).toBe('last update failed, retrying');
    expect(nextLabel(now, { ...base, nextDueMs: null })).toBe('');
  });
});

describe('refreshResult (typed procedure result, older JSON string accepted)', () => {
  it('reads both shapes', () => {
    expect(refreshResult({ ok: false, skipped: 'impersonating', error: '', repaired: false, repairs: [], clusters: 0 })).toEqual({ ok: false, skipped: 'impersonating', error: '' });
    expect(refreshResult('{"ok":true,"clusters":2}')).toEqual({ ok: true, skipped: '', error: '' });
    expect(refreshResult('')).toEqual({ ok: false, skipped: '', error: '' });
  });
});
