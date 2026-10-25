import { useEffect, useState } from 'react';
import type { AppSettings } from './config';
import { useConnection } from './stdb/connection';
import { PickUser } from './screens/PickUser';
import { SessionScreen } from './screens/SessionScreen';
import { ObserverScreen } from './screens/ObserverScreen';
import { Overview } from './screens/Overview';
import { APP_CONFIG } from './app-config';
import { homeUrl, navigate } from './lib/format';

type Route = { name: 'pick' } | { name: 'session'; id: bigint } | { name: 'observe'; id: bigint } | { name: 'overview' };

function parseRoute(search: string): Route {
  const p = new URLSearchParams(search);
  const id = (k: string) => {
    const v = p.get(k);
    return v && /^\d+$/.test(v) ? BigInt(v) : null;
  };
  const s = id('session');
  if (s !== null) return { name: 'session', id: s };
  const o = id('observe');
  if (o !== null) return { name: 'observe', id: o };
  if (p.has('overview')) return { name: 'overview' };
  return { name: 'pick' };
}

export function App({ settings }: { settings: AppSettings }) {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.search));
  const { conn, status, error } = useConnection(settings);

  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.search));
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);

  useEffect(() => {
    window.__tutor.state.route = route.name;
    window.__tutor.state.connStatus = status;
  }, [route, status]);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <a
            href={homeUrl()}
            onClick={e => {
              e.preventDefault();
              navigate(homeUrl());
            }}
            className="font-semibold tracking-tight"
          >
            {APP_CONFIG.pageTitle}
          </a>
          <nav className="flex items-center gap-3 text-sm">
            <a
              data-testid="nav-overview"
              href={homeUrl('overview')}
              onClick={e => {
                e.preventDefault();
                navigate(homeUrl('overview'));
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              Sessions
            </a>
            <span data-testid="conn-status" data-status={status} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={`size-2 rounded-full ${status === 'connected' ? 'bg-emerald-500' : status === 'connecting' ? 'bg-amber-400' : 'bg-red-500'}`} />
              {status}
            </span>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        {status === 'error' ? (
          <p className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Cannot reach SpacetimeDB at {settings.spacetimeUri} / {settings.spacetimeDb}: {error}
          </p>
        ) : null}
        {!conn ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Connecting…</p>
        ) : route.name === 'session' ? (
          <SessionScreen key={`s${route.id}`} conn={conn} sessionId={route.id} settings={settings} />
        ) : route.name === 'observe' ? (
          <ObserverScreen key={`o${route.id}`} conn={conn} sessionId={route.id} />
        ) : route.name === 'overview' ? (
          <Overview conn={conn} />
        ) : (
          <PickUser conn={conn} />
        )}
      </main>
    </div>
  );
}
