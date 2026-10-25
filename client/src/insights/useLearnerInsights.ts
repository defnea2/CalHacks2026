// Loads a learner's long-term profile through the procedure `learnerInsights` (memory is private;
// no subscription). Called once on open and on Refresh; no polling. The last good result is kept
// when a later call fails. `?insightsFixture` (dev) shows a local fixture instead.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { LearnerInsights } from '@tutor/shared';
import { errorText, parseInsights } from '../lib/insights';
import { eventLog } from '../lib/debug';
import { emptyInsightsFixture, insightsFixture } from './fixture';

export const INSIGHTS_KEY_STORAGE = 'tutor.insightsKey';

function storedKey(): string {
  try {
    return window.localStorage.getItem(INSIGHTS_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

/** `?insightsFixture` → fixture; `?insightsFixture=empty` → the empty-state fixture. */
function fixtureMode(): '' | 'full' | 'empty' {
  try {
    const p = new URLSearchParams(window.location.search);
    if (!p.has('insightsFixture')) return '';
    return p.get('insightsFixture') === 'empty' ? 'empty' : 'full';
  } catch {
    return '';
  }
}

type Call = (args: { learnerId: bigint; teacherId: bigint; key: string }) => Promise<string>;

export interface LearnerInsightsState {
  data: LearnerInsights | null;
  /** Plain-words error of the latest call ('' when it succeeded). */
  error: string;
  /** Raw error code ('locked', 'unknown_learner', ...). */
  errorCode: string;
  loading: boolean;
  refresh: () => void;
}

export function useLearnerInsights(conn: DbConnection, learnerId: bigint, teacherId: bigint): LearnerInsightsState {
  const [data, setData] = useState<LearnerInsights | null>(null);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    const fail = (code: string, text = errorText(code)) => {
      if (my !== seq.current) return;
      setErrorCode(code);
      setError(text);
    };
    try {
      const mode = fixtureMode();
      const call = (conn.procedures as unknown as { learnerInsights?: Call }).learnerInsights;
      let json: string;
      if (mode) json = JSON.stringify(mode === 'empty' ? emptyInsightsFixture(Date.now(), learnerId.toString()) : insightsFixture(Date.now(), learnerId.toString()));
      else if (!call) return fail('unavailable', 'Student profiles are not available on this server yet.');
      else {
        eventLog.log('procedure.call', { name: 'learnerInsights', learnerId: learnerId.toString() });
        json = await call.call(conn.procedures, { learnerId, teacherId, key: storedKey() });
      }
      const r = parseInsights(json);
      if (my !== seq.current) return;
      if (r.ok) {
        setData(r);
        setError('');
        setErrorCode('');
      } else fail(r.error);
    } catch (err) {
      fail('call_failed', `The profile could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [conn, learnerId, teacherId]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  return { data, error, errorCode, loading, refresh: () => void load() };
}
