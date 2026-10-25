// Server-side view of one session (via spacetime sql as the database owner).
import { sql, type Row } from './sql';

export interface ServerSession {
  sessionId: string;
  phase: string;
  phrases: { phraseId: number; turnIdx: number; status: string; text: string }[];
  turns: { idx: number; role: string; text: string; status: string; utteranceId: string; interrupted: boolean }[];
  sentences: { utteranceId: string; idx: number; status: string; display: string }[];
  boardItems: { id: string; kind: string; utteranceId: string }[];
  metrics: TurnMetric[];
}

export interface TurnMetric {
  turnIdx: number;
  utteranceId: string;
  preemptive: boolean;
  noiseDb: number;
  /** ms after turn end; null = not recorded. */
  sttDone: number | null;
  llmFirstToken: number | null;
  firstSentence: number | null;
  firstAudio: number | null;
  firstPlayback: number | null;
}

/** SATS option of a timestamp as printed by the CLI: [0, [micros]] = some, [1, []] = none. */
export function tsMicros(v: unknown): number | null {
  if (!Array.isArray(v) || v[0] !== 0) return null;
  const inner = v[1];
  const n = Array.isArray(inner) ? inner[0] : inner;
  return typeof n === 'number' ? n : null;
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown) => Number(v);

export function readSession(db: string, sessionId: string): ServerSession {
  const id = BigInt(sessionId).toString(); // validated: numeric only
  const q = (t: string): Row[] => sql(db, `SELECT * FROM ${t} WHERE session_id = ${id}`);
  const s = sql(db, `SELECT * FROM session WHERE id = ${id}`)[0];
  const metrics = q('turn_metrics').map(r => {
    const end = tsMicros(r.turn_end_at);
    const d = (k: string) => {
      const t = tsMicros(r[k]);
      return end === null || t === null ? null : Math.round((t - end) / 1000);
    };
    return {
      turnIdx: num(r.turn_idx),
      utteranceId: str(r.utterance_id),
      preemptive: !!r.preemptive,
      noiseDb: num(r.noise_db),
      sttDone: d('stt_done_at'),
      llmFirstToken: d('llm_first_token_at'),
      firstSentence: d('first_sentence_at'),
      firstAudio: d('first_audio_at'),
      firstPlayback: d('first_playback_at'),
    };
  });
  return {
    sessionId: id,
    phase: str(s?.phase),
    phrases: q('phrase')
      .map(r => ({ phraseId: num(r.phrase_id), turnIdx: num(r.turn_idx), status: str(r.status), text: str(r.text) }))
      .sort((a, b) => a.phraseId - b.phraseId),
    turns: q('turn')
      .map(r => ({ idx: num(r.idx), role: str(r.role), text: str(r.text), status: str(r.status), utteranceId: str(r.utterance_id), interrupted: !!r.interrupted }))
      .sort((a, b) => a.idx - b.idx),
    sentences: q('reply_sentence')
      .map(r => ({ utteranceId: str(r.utterance_id), idx: num(r.idx), status: str(r.status), display: str(r.display) }))
      .sort((a, b) => (a.utteranceId === b.utteranceId ? a.idx - b.idx : a.utteranceId < b.utteranceId ? -1 : 1)),
    boardItems: q('board_item').map(r => ({ id: str(r.id), kind: str(r.kind), utteranceId: str(r.utterance_id) })),
    metrics: metrics.sort((a, b) => a.turnIdx - b.turnIdx),
  };
}

export function countMemoryNotes(db: string): number {
  const r = sql(db, 'SELECT COUNT(*) AS n FROM memory_note')[0];
  return r ? num(r.n) : 0;
}

export function countMemoryNotesFor(db: string, learnerIds: string[]): number {
  let n = 0;
  for (const l of learnerIds) n += sql(db, `SELECT * FROM memory_note WHERE learner_id = ${BigInt(l).toString()}`).length;
  return n;
}

export function learnerIdOf(db: string, sessionId: string): string {
  return str(sql(db, `SELECT * FROM session WHERE id = ${BigInt(sessionId).toString()}`)[0]?.learner_id);
}
