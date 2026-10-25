import { useEffect, useState } from 'react';
import type { AppSettings } from './config';
import { useConnection } from './stdb/connection';
import { PickUser } from './screens/PickUser';
import { SessionScreen } from './screens/SessionScreen';
import { ObserverScreen } from './screens/ObserverScreen';
import { Overview } from './screens/Overview';
import { MicCheck } from './screens/MicCheck';
import { APP_CONFIG } from './app-config';
import { homeUrl, navigate } from './lib/format';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Buddy } from './design/Buddy';

type Route = { name: 'pick' } | { name: 'session'; id: bigint } | { name: 'observe'; id: bigint } | { name: 'overview' } | { name: 'miccheck' };

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
  if (p.has('miccheck')) return { name: 'miccheck' };
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
    <main className="product-shell">
      <header className="product-header">
          <a
            href={homeUrl()}
            onClick={e => {
              e.preventDefault();
              navigate(homeUrl());
            }}
            className="product-identity"
          >
            <Buddy size={40} className="product-buddy" />
            <span><strong>{APP_CONFIG.pageTitle}</strong><small>Visual learning, made clear</small></span>
          </a>
          <nav>
            <a
              data-testid="nav-overview"
              href={homeUrl('overview')}
              onClick={e => {
                e.preventDefault();
                navigate(homeUrl('overview'));
              }}
            >
              Sessions
            </a>
            <span data-testid="conn-status" data-status={status} className="voice-tab">
              <span className={`dot ${status === 'connected' ? 'is-good' : status === 'connecting' ? 'is-wait' : 'is-bad'}`} />
              {status}
            </span>
          </nav>
      </header>
      <section className="lesson-workspace" aria-label="Learning session">
        {status === 'error' ? (
          <p className="lesson-error">
            Cannot reach SpacetimeDB at {settings.spacetimeUri} / {settings.spacetimeDb}: {error}
          </p>
        ) : null}
        <ErrorBoundary key={`${route.name}${'id' in route ? route.id : ''}`}>
        {route.name === 'miccheck' ? (
          <MicCheck settings={settings} />
        ) : !conn ? (
          <div className="loading-buddy" role="status"><Buddy size={72} /><span className="loading-dots" aria-hidden="true"><i /><i /><i /></span><span>Connecting…</span></div>
        ) : route.name === 'session' ? (
          <SessionScreen key={`s${route.id}`} conn={conn} sessionId={route.id} settings={settings} />
        ) : route.name === 'observe' ? (
          <ObserverScreen key={`o${route.id}`} conn={conn} sessionId={route.id} />
        ) : route.name === 'overview' ? (
          <Overview conn={conn} />
        ) : (
          <PickUser conn={conn} />
        )}
        </ErrorBoundary>
      </section>
    </main>
  );
}
