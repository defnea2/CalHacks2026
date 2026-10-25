// Teacher-facing student profile: what the tutor has learned about a student over time (memory
// notes, mastery, past sessions) in plain words. Long-term only, no live status. Opened from the
// dashboard (drawer) or ?profile=<learnerId>&as=<teacherId> (full page).
import { useEffect, useMemo, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { InsightNote } from '@tutor/shared';
import { ageGrade, atAGlance, evidenceLine, masteryGroups, nextFocus, noteMeta, noteSections, noteSentence, pastSessions, relativeDate, sessionLabels, sessionsLine } from '../lib/insights';
import { Initial } from '../screens/StudentHome';
import { INSIGHTS_KEY_STORAGE, useLearnerInsights } from './useLearnerInsights';

export function StudentProfile({ conn, learnerId, teacherId, fallbackName }: { conn: DbConnection; learnerId: bigint; teacherId: bigint; fallbackName?: string }) {
  const { data, error, errorCode, loading, refresh } = useLearnerInsights(conn, learnerId, teacherId);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [data]);

  const view = useMemo(() => {
    if (!data) return null;
    return {
      glance: atAGlance(data),
      focus: nextFocus(data),
      sections: noteSections(data.notes),
      mastery: masteryGroups(data.mastery),
      sessions: pastSessions(data),
      labels: sessionLabels(now, data),
    };
  }, [data, now]);

  const name = data?.learner.name ?? fallbackName ?? 'Student';
  const l = data?.learner;

  return (
    <section className="sp" data-testid="student-profile" data-learner-id={learnerId.toString()} data-loaded={!!data} aria-label={`Profile of ${name}`}>
      <header className="sp-head">
        <Initial name={name} />
        <div className="sp-who">
          <h2>{name}</h2>
          {l && (
            <p>
              {[ageGrade(l), l.style ? `learns best: ${l.style}` : ''].filter(Boolean).join(' · ')}
              {l.isSimulated && <span className="sp-badge" data-testid="profile-simulated">simulated</span>}
            </p>
          )}
          {l?.isSimulated && l.persona && <p className="sp-persona">{l.persona}</p>}
          {l && (
            <small>
              {sessionsLine(data!)}
              {l.sessionCount > 0 && l.lastSeenMs ? ` · last ${relativeDate(now, l.lastSeenMs)}` : ''}
            </small>
          )}
        </div>
        <button className="pr-secondary sp-refresh" data-testid="profile-refresh" onClick={refresh} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </header>

      {error && (
        <p className="pr-error" data-testid="profile-error" data-error={errorCode}>
          {error}
          {data ? ' Showing the last profile that loaded.' : ''}
        </p>
      )}
      {errorCode === 'locked' && <UnlockKey onSaved={refresh} />}
      {!data && !error && <p className="pr-note">Loading what the tutor knows…</p>}

      {data && view && (
        <>
          <div className="sp-glance" data-testid="profile-glance">
            <span className="pr-eyebrow">At a glance</span>
            <p>{view.glance}</p>
          </div>
          {view.focus && (
            <div className="sp-focus" data-testid="profile-next-focus">
              <span className="pr-eyebrow">Next focus</span>
              <p>{view.focus.text}</p>
              <small>from the session {relativeDate(now, view.focus.fromMs)}</small>
            </div>
          )}

          <h3 className="sp-h">What the tutor has learned</h3>
          {view.sections.length === 0 ? (
            <p className="sp-empty">Nothing noted yet. The tutor learns as {name.split(' ')[0]} practises.</p>
          ) : (
            view.sections.map(s => (
              <div key={s.key} className="sp-section" data-testid="profile-section" data-section={s.key}>
                <h4>
                  {s.title} <span>{s.hint}</span>
                </h4>
                <ul>
                  {s.notes.map(n => (
                    <Note key={n.id} n={n} now={now} labels={view.labels} />
                  ))}
                </ul>
              </div>
            ))
          )}

          <h3 className="sp-h">Mastery</h3>
          {view.mastery.length === 0 ? (
            <p className="sp-empty">No mastery yet. It fills in as they solve tasks with the tutor.</p>
          ) : (
            view.mastery.map(g => (
              <div key={g.category} className="sp-mastery">
                <h4>{g.title}</h4>
                {g.rows.map(r => (
                  <div key={r.concept} className="sp-mrow" data-testid="profile-mastery-row" data-concept={r.concept} data-mastery={r.mastery} title={`${r.mastery} / 100 · updated ${relativeDate(now, r.updatedMs)}`}>
                    <span>{r.title}</span>
                    <i className="sp-bar" data-band={r.band}>
                      <b style={{ width: `${Math.max(r.mastery, 2)}%` }} />
                    </i>
                    <em>{r.band}</em>
                  </div>
                ))}
              </div>
            ))
          )}

          <h3 className="sp-h">Past sessions</h3>
          {view.sessions.length === 0 ? (
            <p className="sp-empty">{l!.sessionCount ? 'No session summaries yet. One is written when a session ends.' : 'No sessions yet. The tutor learns as they practise.'}</p>
          ) : (
            <ol className="sp-sessions">
              {view.sessions.map(s => (
                <li key={s.sessionId} data-testid="profile-session" data-session-id={s.sessionId}>
                  <div className="sp-session-top">
                    <strong>{s.topicTitle || 'Session'}</strong>
                    <small>{relativeDate(now, s.createdMs)}</small>
                  </div>
                  {s.taskText && <p className="sp-task">Task: {s.taskText}</p>}
                  {s.summary && <p>{s.summary}</p>}
                </li>
              ))}
            </ol>
          )}
          <p className="sp-foot">Only teachers see this page. Students never see these notes.</p>
        </>
      )}
    </section>
  );
}

function UnlockKey({ onSaved }: { onSaved: () => void }) {
  const [key, setKey] = useState('');
  return (
    <form
      className="sp-unlock"
      onSubmit={e => {
        e.preventDefault();
        try {
          window.localStorage.setItem(INSIGHTS_KEY_STORAGE, key.trim());
        } catch {
          /* storage blocked: nothing to remember */
        }
        onSaved();
      }}
    >
      <input className="pr-input" type="password" placeholder="Profile key" aria-label="Profile key" data-testid="profile-key" value={key} onChange={e => setKey(e.target.value)} />
      <button className="pr-secondary" type="submit">Unlock</button>
    </form>
  );
}

function Note({ n, now, labels }: { n: InsightNote; now: number; labels: Map<string, string> }) {
  const ev = evidenceLine(n, labels);
  return (
    <li className="sp-note" data-testid="profile-note" data-kind={n.kind} data-outcome={n.outcome}>
      <p>{noteSentence(n)}</p>
      {ev && (
        <blockquote>
          “{ev.quote}” <span>— {ev.where}</span>
        </blockquote>
      )}
      <small>
        {n.conceptTitle && <span className="sp-concept">{n.conceptTitle}</span>}
        {noteMeta(now, n)}
        {n.seeded && <span className="sp-seeded" title="From the starting profile, not learned in a session">seeded</span>}
      </small>
    </li>
  );
}
