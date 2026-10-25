// ?lesson: the team's lesson app (src/app/App: prepared + sample lessons, slant lesson, math
// studio, development tools) inside this client. Its live lessons run over SpacetimeDB: a real
// session (startSession) and the team's TeachingSession on createSpacetimePlanningModel.
// ?harness: the team's planning harness (offline fixtures, or the same live adapter).
import { useMemo } from 'react';
import TeamApp from '@tutor/visual/app/App';
import { TeachingHarness } from '@tutor/visual/teaching/dev/TeachingHarness';
import type { LessonPlanning } from '@tutor/visual/teaching/ui/LessonWorkspace';
import { createSpacetimePlanningModel } from '@tutor/visual/teaching/spacetimeModel';
import '@tutor/visual/app/styles.css';
import '@tutor/visual/app/workspace.css';
import '@tutor/visual/teaching/ui/lesson.css';
import type { DbConnection } from '../module_bindings';
import type { Learner, Session } from '../module_bindings/types';
import type { AppSettings } from '../config';
import { callReducer, subscribe, useConnection } from '../stdb/connection';
import { useAgentStatus } from '../session/useAgentStatus';
import { sessionUrl } from '../lib/format';

type Cb = (...args: any[]) => void;
interface Watchable<R> {
  iter(): Iterable<R>;
  onInsert(cb: Cb): void;
  removeOnInsert(cb: Cb): void;
  onUpdate?(cb: Cb): void;
  removeOnUpdate?(cb: Cb): void;
}

/** Resolves with the first row matching `pick` once `queries` are applied (or rejects after `ms`). */
function waitForRow<R>(conn: DbConnection, queries: string[], table: Watchable<R>, pick: (rows: R[]) => R | undefined, ms = 10_000): Promise<R> {
  return new Promise((resolve, reject) => {
    const sub = subscribe(conn, queries, 'lab wait');
    const check = () => {
      const r = pick([...table.iter()]);
      if (r) done(null, r);
    };
    const timer = setTimeout(() => done(new Error('SpacetimeDB did not confirm in time.')), ms);
    const done = (e: Error | null, r?: R) => {
      clearTimeout(timer);
      table.removeOnInsert(check);
      table.removeOnUpdate?.(check);
      sub.unsubscribe();
      if (e) reject(e);
      else resolve(r!);
    };
    table.onInsert(check);
    table.onUpdate?.(check);
    sub.ready.then(check, e => done(e instanceof Error ? e : new Error(String(e))));
  });
}

/** Learner from ?learner=<id>, else a fresh guest learner. Then a new session for the topic. */
export async function startLiveLesson(conn: DbConnection, input: { topic: string; originalQuestion: string; age: number }) {
  const param = new URLSearchParams(window.location.search).get('learner');
  let learnerId = param && /^\d+$/.test(param) ? BigInt(param) : null;
  if (learnerId === null) {
    const name = `Guest ${Math.floor(Math.random() * 9000 + 1000)}`;
    const args = { name, age: input.age, grade: Math.max(0, Math.min(13, input.age - 5)), style: '' };
    const r = await callReducer('createTestUser', args, () => conn.reducers.createTestUser(args));
    if (!r.ok) throw new Error(r.error ?? 'Could not create a learner.');
    const learner = await waitForRow<Learner>(conn, ['SELECT * FROM learner'], conn.db.learner, rows => rows.filter(l => l.name === name).sort((a, b) => (a.id > b.id ? -1 : 1))[0]);
    learnerId = learner.id;
  }
  const taskText = [input.topic, input.originalQuestion].filter(Boolean).join('\n');
  const args = { learnerId, taskText };
  const r = await callReducer('startSession', args, () => conn.reducers.startSession(args));
  if (!r.ok) throw new Error(r.error ?? 'Could not start a session.');
  const lid = learnerId;
  const session = await waitForRow<Session>(conn, [`SELECT * FROM session WHERE learner_id = ${lid}`], conn.db.session, rows =>
    rows.filter(s => s.learnerId === lid && s.active).sort((a, b) => (a.id > b.id ? -1 : 1))[0]
  );
  const model = createSpacetimePlanningModel(conn, session.id);
  return { model, sessionId: session.id.toString(), link: sessionUrl('session', session.id), close: model.close };
}

function usePlanning(conn: DbConnection | null): LessonPlanning | undefined {
  const agent = useAgentStatus(conn);
  return useMemo(
    () => (conn ? { status: agent.label, online: agent.online, start: (input: { topic: string; originalQuestion: string; age: number }) => startLiveLesson(conn, input) } : undefined),
    [conn, agent.label, agent.online]
  );
}

export function TeamLab({ settings }: { settings: AppSettings }) {
  const { conn } = useConnection(settings);
  return <TeamApp planning={usePlanning(conn)} />;
}

export function TeamHarness() {
  return <TeachingHarness />;
}
