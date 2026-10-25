// One SpacetimeDB connection per tab (no shared token, no global state across tabs).
import { useEffect, useState } from 'react';
import { DbConnection } from '../module_bindings';
import type { AppSettings } from '../config';
import { eventLog } from '../lib/debug';

export type ConnStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export function useConnection(settings: AppSettings): { conn: DbConnection | null; status: ConnStatus; error: string } {
  const [conn, setConn] = useState<DbConnection | null>(null);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    eventLog.log('conn.connecting', { uri: settings.spacetimeUri, db: settings.spacetimeDb });
    const c = DbConnection.builder()
      .withUri(settings.spacetimeUri)
      .withDatabaseName(settings.spacetimeDb)
      // Confirmed reads stay ON in the client (~5.5 ms per hop, docs/latency-internal.md): with
      // unconfirmed reads a row seen by the previous screen's subscription went missing from the
      // cache when the session screen swapped subscriptions ("Session N does not exist", 3 of 5
      // runs on night/base). The worker, whose subscriptions never change, keeps them off.
      .withConfirmedReads(true)
      .onConnect((cn, identity) => {
        if (!alive) return;
        eventLog.log('conn.connected', { identity: identity.toHexString().slice(0, 16) });
        setStatus('connected');
        setConn(cn);
      })
      .onConnectError((_ctx, err) => {
        if (!alive) return;
        eventLog.log('conn.error', { error: String(err) });
        setError(String(err?.message ?? err));
        setStatus('error');
      })
      .onDisconnect((_ctx, err) => {
        if (!alive) return;
        eventLog.log('conn.disconnected', { error: err ? String(err) : '' });
        setStatus('disconnected');
      })
      .build();
    return () => {
      alive = false;
      try {
        c.disconnect();
      } catch {
        /* ignore */
      }
    };
  }, [settings.spacetimeUri, settings.spacetimeDb]);

  return { conn, status, error };
}

/** Subscribes to SQL queries; resolves once applied. Returns an unsubscribe function. */
export function subscribe(conn: DbConnection, queries: string[], label: string): { ready: Promise<void>; unsubscribe: () => void } {
  let handle: { unsubscribe: () => void; isEnded?: () => boolean } | null = null;
  let done = false;
  const ready = new Promise<void>((resolve, reject) => {
    handle = conn
      .subscriptionBuilder()
      .onApplied(() => {
        eventLog.log('sub.applied', { label, queries });
        resolve();
      })
      .onError(ctx => {
        const msg = String((ctx as unknown as { event?: unknown }).event ?? 'subscription error');
        eventLog.log('sub.error', { label, queries, error: msg });
        reject(new Error(msg));
      })
      .subscribe(queries);
  });
  ready.catch(() => {});
  return {
    ready,
    unsubscribe: () => {
      if (done) return;
      done = true;
      try {
        handle?.unsubscribe();
      } catch {
        /* already ended */
      }
    },
  };
}

export interface CallResult {
  ok: boolean;
  error?: string;
}

/** Calls a reducer, logs it, never throws (stubbed reducers reject with "not implemented"). */
export async function callReducer(name: string, args: Record<string, unknown>, fn: () => Promise<void>, quiet = false): Promise<CallResult> {
  const t0 = performance.now();
  if (!quiet) eventLog.log('reducer.call', { name, args: summarize(args) });
  try {
    await fn();
    eventLog.log('reducer.ok', { name, ms: Math.round(performance.now() - t0), ...(quiet ? { args: summarize(args) } : {}) });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    eventLog.log('reducer.error', { name, error: msg, args: summarize(args) });
    return { ok: false, error: msg };
  }
}

function summarize(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v instanceof Uint8Array) out[k] = `<${v.length} bytes>`;
    else if (typeof v === 'bigint') out[k] = v.toString();
    else out[k] = v;
  }
  return out;
}
