import { useEffect, useState } from 'react';
import type { AppSettings } from './config';
import { useConnection } from './stdb/connection';
import { Entry } from './screens/Entry';
import { StudentHome, StudentStart } from './screens/StudentHome';
import { WaitingRoom } from './screens/WaitingRoom';
import { TeacherHome, ClassSetup } from './screens/TeacherHome';
import { Dashboard } from './screens/Dashboard';
import { SessionScreen } from './screens/SessionScreen';
import { ObserverScreen } from './screens/ObserverScreen';
import { Overview } from './screens/Overview';
import { MicCheck } from './screens/MicCheck';
import { StudentProfile } from './insights/StudentProfile';
import { homeUrl, navigate, routeUrl } from './lib/format';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AccountGate } from './components/AccountGate';
import { AccountsReady, useAccountSubscription } from './stdb/useAccounts';
import { Wordmark, BRAND } from './brand/Logo';
import './product.css';

export type Route =
  | { name: 'entry' }
  | { name: 'students' }
  | { name: 'student'; id: bigint }
  | { name: 'wait'; id: bigint }
  | { name: 'teachers' }
  | { name: 'teacher'; id: bigint }
  | { name: 'class'; id: bigint }
  | { name: 'session'; id: bigint }
  | { name: 'observe'; id: bigint }
  | { name: 'overview' }
  | { name: 'profile'; id: bigint; teacherId: bigint }
  | { name: 'miccheck' };

export function parseRoute(search: string): Route {
  const p = new URLSearchParams(search);
  const id = (k: string) => {
    const v = p.get(k);
    return v && /^\d+$/.test(v) ? BigInt(v) : null;
  };
  const withId = (k: 'session' | 'observe' | 'class' | 'wait' | 'student' | 'teacher') => {
    const v = id(k);
    return v === null ? null : ({ name: k, id: v } as Route);
  };
  const profile = id('profile');
  if (profile !== null) return { name: 'profile', id: profile, teacherId: id('as') ?? 0n };
  for (const k of ['session', 'observe', 'class', 'wait'] as const) {
    const r = withId(k);
    if (r) return r;
  }
  if (p.has('overview')) return { name: 'overview' };
  if (p.has('miccheck')) return { name: 'miccheck' };
  for (const k of ['student', 'teacher'] as const) {
    const r = withId(k);
    if (r) return r;
    if (p.has(k)) return { name: k === 'student' ? 'students' : 'teachers' };
  }
  return { name: 'entry' };
}

const CONTEXT: Partial<Record<Route['name'], string>> = {
  students: 'Student', student: 'Student', wait: 'Student', session: 'Lesson',
  teachers: 'Teacher', teacher: 'Teacher', class: 'Class dashboard', observe: 'Observer', overview: 'All sessions', profile: 'Student profile',
};

export function App({ settings }: { settings: AppSettings }) {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.search));
  const { conn, status, error, identity } = useConnection(settings);
  const accountsReady = useAccountSubscription(conn);

  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.search));
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);

  useEffect(() => {
    window.__tutor.state.route = route.name;
    window.__tutor.state.connStatus = status;
  }, [route, status]);

  useEffect(() => {
    const ctx = CONTEXT[route.name];
    document.title = ctx ? `${BRAND.name} · ${ctx}` : BRAND.name;
  }, [route.name]);

  const lesson = route.name === 'session' || route.name === 'observe';
  const link = (url: string) => ({
    href: url,
    onClick: (e: React.MouseEvent) => {
      e.preventDefault();
      navigate(url);
    },
  });

  return (
    <div className={`pr-app ${lesson ? 'studio-app' : ''}`}>
      <header className="pr-header">
        <a className="pr-identity" {...link(homeUrl())}>
          <Wordmark size={21} className="pr-wordmark" />
          {CONTEXT[route.name] && <small>{CONTEXT[route.name]}</small>}
        </a>
        <nav className="pr-nav">
          <a href="?lesson" data-testid="nav-lesson">Lesson lab</a>
          <a data-testid="nav-overview" {...link(routeUrl({ overview: '' }))}>Sessions</a>
          <span data-testid="conn-status" data-status={status} data-identity={identity} className="pr-conn" title={`${settings.spacetimeUri} / ${settings.spacetimeDb}${identity ? ` · device ${identity.slice(0, 8)}` : ''}`}>
            <i />
            {status}
          </span>
        </nav>
      </header>
      <main className={lesson ? 'studio-main' : route.name === 'class' ? 'pr-main pr-main-wide' : 'pr-main'}>
        {status === 'error' ? (
          <p className="pr-error">
            Cannot reach SpacetimeDB at {settings.spacetimeUri} / {settings.spacetimeDb}: {error}
          </p>
        ) : null}
        <AccountsReady.Provider value={accountsReady}>
        <ErrorBoundary key={`${route.name}${'id' in route ? route.id : ''}`}>
          {route.name === 'miccheck' ? (
            <MicCheck settings={settings} />
          ) : route.name === 'entry' ? (
            <Entry conn={conn} />
          ) : !conn ? (
            <p className="pr-note" style={{ padding: '64px 0', textAlign: 'center' }}>Connecting…</p>
          ) : route.name === 'session' ? (
            <AccountGate conn={conn} target={{ kind: 'session', id: route.id }}>
              <SessionScreen key={`s${route.id}`} conn={conn} sessionId={route.id} settings={settings} />
            </AccountGate>
          ) : route.name === 'observe' ? (
            <ObserverScreen key={`o${route.id}`} conn={conn} sessionId={route.id} />
          ) : route.name === 'profile' ? (
            <AccountGate conn={conn} target={{ kind: 'teacher', id: route.teacherId }}>
              <div className="sp-page">
                <StudentProfile key={`p${route.id}`} conn={conn} learnerId={route.id} teacherId={route.teacherId} />
              </div>
            </AccountGate>
          ) : route.name === 'overview' ? (
            <Overview conn={conn} />
          ) : route.name === 'students' ? (
            <StudentHome conn={conn} />
          ) : route.name === 'student' ? (
            <AccountGate conn={conn} target={{ kind: 'learner', id: route.id }}>
              <StudentStart key={`l${route.id}`} conn={conn} learnerId={route.id} />
            </AccountGate>
          ) : route.name === 'wait' ? (
            <AccountGate conn={conn} target={{ kind: 'learner', id: route.id }}>
              <WaitingRoom key={`w${route.id}`} conn={conn} learnerId={route.id} />
            </AccountGate>
          ) : route.name === 'teachers' ? (
            <TeacherHome conn={conn} />
          ) : route.name === 'teacher' ? (
            <AccountGate conn={conn} target={{ kind: 'teacher', id: route.id }}>
              <ClassSetup key={`t${route.id}`} conn={conn} teacherId={route.id} />
            </AccountGate>
          ) : (
            <AccountGate conn={conn} target={{ kind: 'class', id: route.id }}>
              <Dashboard key={`c${route.id}`} conn={conn} classSessionId={route.id} />
            </AccountGate>
          )}
        </ErrorBoundary>
        </AccountsReady.Provider>
      </main>
    </div>
  );
}
