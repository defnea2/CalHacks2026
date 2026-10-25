// Minimal React binding over the SDK's client cache: rows of one table matching a filter,
// refreshed on insert/update/delete (coalesced per animation frame).
//
// One shared snapshot per table: however many components read a table, its rows are copied out of
// the SDK cache once per change (not once per hook), and a hook re-filters only when that table
// changed or its own deps did. (The SDK's `spacetimedb/react` `useTable` needs a
// `SpacetimeDBProvider` and owns its subscription, so it is no drop-in for the app's connection.)
import { useEffect, useRef, useState } from 'react';

type Cb = (...args: any[]) => void;
export interface TableLike<R> {
  iter(): Iterable<R>;
  onInsert(cb: Cb): void;
  removeOnInsert(cb: Cb): void;
  onDelete(cb: Cb): void;
  removeOnDelete(cb: Cb): void;
  onUpdate?(cb: Cb): void;
  removeOnUpdate?(cb: Cb): void;
}

interface Store<R> {
  rows: R[] | null;
  /** Bumped on every change of the table. */
  version: number;
  listeners: Set<() => void>;
  scheduled: boolean;
  onChange: () => void;
}

const stores = new WeakMap<object, Store<unknown>>();

function schedule(run: () => void): void {
  if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && document.visibilityState === 'visible') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

function storeOf<R>(table: TableLike<R>): Store<R> {
  let s = stores.get(table) as Store<R> | undefined;
  if (s) return s;
  const store: Store<R> = {
    rows: null,
    version: 0,
    listeners: new Set(),
    scheduled: false,
    onChange: () => {
      store.rows = null;
      store.version++;
      if (store.scheduled) return;
      store.scheduled = true;
      schedule(() => {
        store.scheduled = false;
        for (const l of [...store.listeners]) l();
      });
    },
  };
  stores.set(table, store as Store<unknown>);
  return store;
}

/** The table's rows, copied out of the cache at most once per change. */
export function tableSnapshot<R>(table: TableLike<R>): R[] {
  const s = storeOf(table);
  if (s.listeners.size === 0) return [...table.iter()]; // not tracked: no cache
  return (s.rows ??= [...table.iter()]);
}

export function listen<R>(table: TableLike<R>, l: () => void): () => void {
  const s = storeOf(table);
  if (s.listeners.size === 0) {
    s.rows = null; // changes while nobody listened were not tracked
    table.onInsert(s.onChange);
    table.onDelete(s.onChange);
    table.onUpdate?.(s.onChange);
  }
  s.listeners.add(l);
  return () => {
    s.listeners.delete(l);
    if (s.listeners.size === 0) {
      table.removeOnInsert(s.onChange);
      table.removeOnDelete(s.onChange);
      table.removeOnUpdate?.(s.onChange);
      s.rows = null;
    }
  };
}

export function useRows<R>(table: TableLike<R> | null | undefined, filter: (r: R) => boolean, deps: unknown[]): R[] {
  const [rows, setRows] = useState<R[]>([]);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => {
    if (!table) {
      setRows([]);
      return;
    }
    let seen: R[] | null = null;
    const refresh = () => {
      const all = tableSnapshot(table);
      if (all === seen) return; // this table did not change since the last filter
      seen = all;
      setRows(all.filter(r => filterRef.current(r)));
    };
    const stop = listen(table, refresh);
    refresh();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, ...deps]);

  return rows;
}
