// One SpacetimeDB connection per tab. The token is kept (lib/token.ts), so the identity, and
// with it the accounts this device owns, survives reloads.
import { useEffect, useState } from 'react';
import { DbConnection } from '../module_bindings';
import type { AppSettings } from '../config';
import { eventLog } from '../lib/debug';
import { browserTokenEnv, clearToken, loadToken, saveToken } from '../lib/token';

export type ConnStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export function useConnection(settings: AppSettings): { conn: DbConnection | null; status: ConnStatus; error: string; identity: string } {
  const [conn, setConn] = useState<DbConnection | null>(null);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [error, setError] = useState('');
  const [identity, setIdentity] = useState('');
  /** Bumped once when a stored token is rejected (e.g. the local server was reset): reconnect without it. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    const env = browserTokenEnv();
    const token = attempt === 0 ? loadToken(env, settings.spacetimeUri, settings.spacetimeDb) : undefined;
    eventLog.log('conn.connecting', { uri: settings.spacetimeUri, db: settings.spacetimeDb, storedToken: Boolean(token) });
    const c = DbConnection.builder()
      .withUri(settings.spacetimeUri)
      .withDatabaseName(settings.spacetimeDb)
      .withToken(token)
      // Confirmed reads stay ON in the client (~5.5 ms per hop, docs/latency-internal.md): with
      // unconfirmed reads a row seen by the previous screen's subscription went missing from the
      // cache when the session screen swapped subscriptions ("Session N does not exist", 3 of 5
      // runs on night/base). The worker, whose subscriptions never change, keeps them off.
      .withConfirmedReads(true)
      .onConnect((cn, id, newToken) => {
        if (!alive) return;
        saveToken(env, settings.spacetimeUri, settings.spacetimeDb, newToken);
        const hex = id.toHexString();
        eventLog.log('conn.connected', { identity: hex.slice(0, 16), reused: Boolean(token) });
        if (typeof window !== 'undefined' && window.__tutor) window.__tutor.state.identity = hex;
        setIdentity(hex);
        setStatus('connected');
        setConn(cn);
      })
      .onConnectError((_ctx, err) => {
        if (!alive) return;
        eventLog.log('conn.error', { error: String(err), storedToken: Boolean(token) });
        if (token) {
          // A token this server does not accept: forget it and connect as a new device.
          clearToken(env, settings.spacetimeUri, settings.spacetimeDb);
          setAttempt(a => a + 1);
          return;
        }
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
  }, [settings.spacetimeUri, settings.spacetimeDb, attempt]);

  return { conn, status, error, identity };
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
