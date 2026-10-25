// Views shared by the session screen and the observer.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionData } from '../stdb/useSessionData';
import type { ReplySentence } from '../module_bindings/types';
import { utteranceProgress, type UtteranceProgress } from '../board/reveal';
import { Badge, Card, CardHeader, cx } from './ui';
import { diffMs, fmtMs, phaseLabel, topicLabel, tsMs } from '../lib/format';
import { eventLog, type LogEvent } from '../lib/debug';
import { metricsSortKey, metricsTurnLabel } from '../lib/conversation';
import type { NoiseState } from '../audio/noise';

const PLAYED = 'played';
const DROPPED = 'dropped';
const TUTOR = 'tutor';

/** Reveal progress + "is this utterance over" for board and captions. */
export function useUtteranceState(data: SessionData, localStarted: Map<string, number[]>) {
  const { session, turns, sentences } = data;
  const serverOver = useMemo(() => {
    const done = new Set(turns.filter(t => t.role === TUTOR && t.utteranceId !== 0n).map(t => t.utteranceId.toString()));
    const current = session?.currentUtteranceId ?? 0n;
    return (u: bigint) => done.has(u.toString()) || u !== current;
  }, [turns, session?.currentUtteranceId]);
  const progress = useMemo<Map<string, UtteranceProgress>>(
    () => utteranceProgress(sentences, localStarted, serverOver, [PLAYED], [PLAYED, DROPPED]),
    [sentences, localStarted, serverOver]
  );
  return { serverOver, progress };
}

// ---------------------------------------------------------------- header / indicators

const TURN_STYLE: Record<string, string> = {
  listening: 'bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-100',
  thinking: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/40 dark:text-amber-100',
  speaking: 'bg-sky-100 text-sky-900 border-sky-200 dark:bg-sky-900/40 dark:text-sky-100',
  interrupted: 'bg-rose-100 text-rose-900 border-rose-200 dark:bg-rose-900/40 dark:text-rose-100',
};

export function Indicators({ data, noise }: { data: SessionData; noise?: { state: NoiseState; floorDb: number | null } }) {
  const s = data.session;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge data-testid="phase-indicator" data-phase={s?.phase ?? ''}>
        Phase: {phaseLabel(s?.phase ?? '')}
      </Badge>
      <Badge data-testid="topic-indicator" data-category={s?.category ?? ''} data-concept={s?.concept ?? ''}>
        Topic: {topicLabel(s?.category ?? '', s?.concept ?? '')}
      </Badge>
      <Badge data-testid="turnstate-indicator" data-state={s?.turnState ?? ''} className={TURN_STYLE[s?.turnState ?? ''] ?? ''}>
        {s?.turnState || '—'}
      </Badge>
      {noise ? (
        <Badge data-testid="noise-indicator" data-noise={noise.state} data-floor={noise.floorDb === null ? '' : noise.floorDb.toFixed(1)}>
          <span className={cx('size-2 rounded-full', noise.state === 'quiet' ? 'bg-emerald-500' : noise.state === 'moderate' ? 'bg-amber-400' : 'bg-red-500')} />
          {noise.state}
          {noise.floorDb !== null ? ` · ${noise.floorDb.toFixed(0)} dBFS` : ''}
        </Badge>
      ) : null}
    </div>
  );
}

export function SessionTitle({ data, suffix }: { data: SessionData; suffix?: string }) {
  const s = data.session;
  return (
    <div className="flex flex-wrap items-baseline gap-3">
      <h1 data-testid="learner-name" className="text-2xl font-semibold tracking-tight">
        {data.learner?.name ?? (s ? `Learner ${s.learnerId}` : '…')}
      </h1>
      <span data-testid="session-code" data-session-id={s?.id.toString() ?? ''} className="rounded-md bg-secondary px-2 py-0.5 font-mono text-sm">
        {s?.code || (s ? `#${s.id}` : '')}
      </span>
      {s && !s.active ? <Badge data-testid="session-ended">ended</Badge> : null}
      {suffix ? <span className="text-sm text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------- captions

interface CaptionEntry {
  key: string;
  role: 'student' | 'tutor';
  at: number;
  parts: { id: string; text: string; status: string }[];
  ref: string;
}

export function Captions({
  data,
  tutorShown,
}: {
  data: SessionData;
  /** Which tutor sentences to show (playing locally / played on the server). */
  tutorShown: (s: ReplySentence) => boolean;
}) {
  const entries = useMemo(() => {
    const byTurn = new Map<number, CaptionEntry>();
    for (const p of [...data.phrases].sort((a, b) => a.phraseId - b.phraseId)) {
      if (p.status === 'discarded') continue;
      const e = byTurn.get(p.turnIdx) ?? { key: `s${p.turnIdx}`, role: 'student' as const, at: tsMs(p.startedAt) ?? 0, parts: [], ref: String(p.turnIdx) };
      e.parts.push({ id: String(p.phraseId), text: p.text, status: p.status });
      byTurn.set(p.turnIdx, e);
    }
    const byUtt = new Map<string, CaptionEntry>();
    for (const s of [...data.sentences].sort((a, b) => a.idx - b.idx)) {
      if (!tutorShown(s)) continue;
      const k = s.utteranceId.toString();
      const e = byUtt.get(k) ?? { key: `t${k}`, role: 'tutor' as const, at: tsMs(s.createdAt) ?? 0, parts: [], ref: k };
      e.parts.push({ id: String(s.idx), text: s.display || s.speech, status: s.status });
      byUtt.set(k, e);
    }
    return [...byTurn.values(), ...byUtt.values()].sort((a, b) => a.at - b.at);
  }, [data.phrases, data.sentences, tutorShown]);

  const transcript = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    // Scroll this panel only. New speech must never move the canvas off screen.
    if (transcript.current && follow.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [entries]);

  return (
    <div ref={transcript} data-testid="captions" className="lesson-transcript flex max-h-[420px] min-h-40 flex-col gap-3 overflow-y-auto p-4" onScroll={() => { const el = transcript.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
      {entries.length === 0 ? <p className="text-sm text-muted-foreground">Your conversation will appear here as you talk.</p> : null}
      {entries.map(e => (
        <div
          key={e.key}
          data-testid={e.role === 'student' ? 'caption-student' : 'caption-tutor'}
          data-ref={e.ref}
          className={cx('caption-entry max-w-[85%] rounded-2xl px-4 py-2 text-[15px] leading-snug', e.role === 'student' ? 'self-end bg-primary text-primary-foreground' : 'self-start bg-secondary')}
        >
          <span className="caption-speaker">{e.role === 'student' ? 'You' : 'Tutor'}</span>
          {e.parts.map(p => (
            <span
              key={p.id}
              data-testid={e.role === 'student' ? 'caption-phrase' : 'caption-sentence'}
              data-id={p.id}
              data-status={p.status}
              className={cx(p.text ? '' : 'italic opacity-60')}
            >
              {p.text || (p.status === 'done' ? '' : '…')}{' '}
            </span>
          ))}
        </div>
      ))}

    </div>
  );
}

// ---------------------------------------------------------------- debug panel

const METRIC_COLS: { key: 'sttDoneAt' | 'llmFirstTokenAt' | 'firstSentenceAt' | 'firstAudioAt' | 'firstPlaybackAt'; label: string }[] = [
  { key: 'sttDoneAt', label: 'STT done' },
  { key: 'llmFirstTokenAt', label: 'LLM 1st token' },
  { key: 'firstSentenceAt', label: '1st sentence' },
  { key: 'firstAudioAt', label: '1st audio' },
  { key: 'firstPlaybackAt', label: '1st playback' },
];

export function MetricsTable({ data, localLatency }: { data: SessionData; localLatency?: Map<number, number> }) {
  const rows = [...data.metrics].sort((a, b) => metricsSortKey(a.turnIdx) - metricsSortKey(b.turnIdx));
  return (
    <div className="overflow-x-auto">
      <table data-testid="metrics-table" className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="text-left">
            <th className="px-2 py-1 font-medium">Turn</th>
            {METRIC_COLS.map(c => (
              <th key={c.key} className="px-2 py-1 font-medium">
                → {c.label}
              </th>
            ))}
            <th className="px-2 py-1 font-medium">Noise</th>
            <th className="px-2 py-1 font-medium">Pre</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-2 py-2 text-muted-foreground">
                No turns measured yet.
              </td>
            </tr>
          ) : null}
          {rows.map(m => {
            const d = Object.fromEntries(METRIC_COLS.map(c => [c.key, diffMs(m.turnEndAt, m[c.key])]));
            return (
              <tr
                key={m.id.toString()}
                data-testid="metrics-row"
                data-turn={m.turnIdx}
                data-utterance={m.utteranceId.toString()}
                data-first-audio-ms={d.firstAudioAt ?? ''}
                data-first-playback-ms={d.firstPlaybackAt ?? ''}
                className="border-t"
              >
                <td className="px-2 py-1">{metricsTurnLabel(m.turnIdx)}</td>
                {METRIC_COLS.map(c => (
                  <td key={c.key} className={cx('px-2 py-1', c.key === 'firstAudioAt' && (d[c.key] ?? 0) > 2500 ? 'text-destructive' : '')}>
                    {fmtMs(d[c.key] ?? null)}
                  </td>
                ))}
                <td className="px-2 py-1">{m.noiseDb ? `${m.noiseDb.toFixed(0)} dB` : '—'}</td>
                <td className="px-2 py-1">{m.preemptive ? 'yes' : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {localLatency && localLatency.size > 0 ? (
        <p data-testid="local-latency" className="mt-2 text-xs text-muted-foreground">
          This tab, turn end → first audio heard:{' '}
          {[...localLatency.values()].map((v, i) => (
            <span key={i} className="mr-2 font-mono">
              {fmtMs(v)}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

export function EventLogView() {
  const [events, setEvents] = useState<LogEvent[]>(() => eventLog.events.slice(-200));
  const [filter, setFilter] = useState('');
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    return eventLog.subscribe(() => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        setEvents(eventLog.events.slice(-200));
      }, 250);
    });
  }, []);
  const shown = filter ? events.filter(e => e.type.includes(filter)) : events;
  return (
    <div className="flex flex-col gap-2">
      <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="filter, e.g. vad or reducer.error" className="h-8 rounded-md border bg-background px-2 text-xs" />
      <pre data-testid="event-log" className="max-h-72 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-tight">
        {shown
          .slice()
          .reverse()
          .map(e => {
            const { t, wall: _w, type, ...rest } = e;
            return `${(t / 1000).toFixed(3)} ${type} ${JSON.stringify(rest, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`;
          })
          .join('')}
      </pre>
    </div>
  );
}

export function DebugPanel({ data, localLatency }: { data: SessionData; localLatency?: Map<number, number> }) {
  return (
    <Card data-testid="debug-panel">
      <CardHeader title="Debug" />
      <div className="flex flex-col gap-4 p-4">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Latency per turn (from turn end)</p>
          <MetricsTable data={data} localLatency={localLatency} />
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Event log</p>
          <EventLogView />
        </div>
      </div>
    </Card>
  );
}
