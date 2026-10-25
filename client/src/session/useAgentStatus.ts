// Worker heartbeat (`agent_status`, replaces the team's GET /api/teaching/status).
import { useEffect, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { AgentStatus } from '../module_bindings/types';
import { subscribe } from '../stdb/connection';
import { useRows } from '../stdb/useRows';
import { tsMs } from '../lib/format';

/** A heartbeat older than this counts as offline. */
export const AGENT_STALE_MS = 30_000;

export interface AgentStatusView {
  online: boolean;
  model: string;
  provider: string;
  busySessions: number;
  label: string;
}

export function agentStatusView(row: AgentStatus | undefined, now: number): AgentStatusView {
  const seen = tsMs(row?.lastSeen);
  const online = !!row && seen !== null && now - seen < AGENT_STALE_MS;
  return {
    online,
    model: row?.model ?? '',
    provider: row?.provider ?? '',
    busySessions: row?.busySessions ?? 0,
    label: !row ? 'Tutor not connected yet: start the worker.' : online ? `Connected to ${row.model || 'the tutor'}` : 'Tutor offline: start the worker.',
  };
}

export function useAgentStatus(conn: DbConnection | null): AgentStatusView {
  useEffect(() => {
    if (!conn) return;
    const sub = subscribe(conn, ['SELECT * FROM agent_status'], 'agent_status');
    return () => sub.unsubscribe();
  }, [conn]);
  const rows = useRows<AgentStatus>(conn?.db.agentStatus, () => true, []);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  return agentStatusView(rows.find(r => r.id === 0) ?? rows[0], now);
}
