// Minimal React binding over the SDK's client cache: rows of one table matching a filter,
// refreshed on insert/update/delete (coalesced per animation frame).
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

export function useRows<R>(table: TableLike<R> | null | undefined, filter: (r: R) => boolean, deps: unknown[]): R[] {
  const [rows, setRows] = useState<R[]>([]);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => {
    if (!table) {
      setRows([]);
      return;
    }
    let scheduled = false;
    const refresh = () => setRows([...table.iter()].filter(r => filterRef.current(r)));
    const onChange = () => {
      if (scheduled) return;
      scheduled = true;
      const run = () => {
        scheduled = false;
        refresh();
      };
      if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') requestAnimationFrame(run);
      else setTimeout(run, 16);
    };
    refresh();
    table.onInsert(onChange);
    table.onDelete(onChange);
    table.onUpdate?.(onChange);
    return () => {
      table.removeOnInsert(onChange);
      table.removeOnDelete(onChange);
      table.removeOnUpdate?.(onChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, ...deps]);

  return rows;
}
