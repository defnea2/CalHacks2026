// useRows' shared per-table snapshot: one copy out of the SDK cache per change, however many readers.
import { describe, expect, it } from 'vitest';
import { listen, tableSnapshot, type TableLike } from '../src/stdb/useRows';

function fakeTable(initial: number[]) {
  const rows = [...initial];
  const cbs = { insert: new Set<() => void>(), delete: new Set<() => void>(), update: new Set<() => void>() };
  let iters = 0;
  const table: TableLike<number> = {
    iter: () => {
      iters++;
      return rows[Symbol.iterator]();
    },
    onInsert: cb => cbs.insert.add(cb),
    removeOnInsert: cb => cbs.insert.delete(cb),
    onDelete: cb => cbs.delete.add(cb),
    removeOnDelete: cb => cbs.delete.delete(cb),
    onUpdate: cb => cbs.update.add(cb),
    removeOnUpdate: cb => cbs.update.delete(cb),
  };
  return {
    table,
    cbs,
    iters: () => iters,
    insert(v: number) {
      rows.push(v);
      for (const cb of cbs.insert) cb();
    },
  };
}

const tick = () => new Promise(r => setTimeout(r, 30));

describe('useRows store', () => {
  it('copies the rows once per change for all readers and notifies once per frame', async () => {
    const t = fakeTable([1, 2]);
    let a = 0;
    let b = 0;
    const stopA = listen(t.table, () => a++);
    const stopB = listen(t.table, () => b++);
    expect(t.cbs.insert.size).toBe(1); // one SDK callback per table, not per reader
    expect(tableSnapshot(t.table)).toEqual([1, 2]);
    expect(tableSnapshot(t.table)).toBe(tableSnapshot(t.table));
    expect(t.iters()).toBe(1);
    t.insert(3);
    t.insert(4);
    await tick();
    expect([a, b]).toEqual([1, 1]); // coalesced
    expect(tableSnapshot(t.table)).toEqual([1, 2, 3, 4]);
    tableSnapshot(t.table);
    expect(t.iters()).toBe(2);
    stopA();
    stopB();
    expect(t.cbs.insert.size).toBe(0);
    // Untracked reads are never cached.
    t.insert(5);
    expect(tableSnapshot(t.table)).toEqual([1, 2, 3, 4, 5]);
  });
});
