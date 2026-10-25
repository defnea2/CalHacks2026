// Transport (worker/src/transport.ts) over SpacetimeDB's HTTP API, for LessonRun inside the
// Cloudflare Worker: POST {STDB_URL}/v1/database/{db}/call/{snake_name} with a positional JSON
// array and `Authorization: Bearer <agent token>`.
//
// Encoding (checked against a local 2.13 server, docs/CLOUD_PLAN.md B1):
// - reducer/procedure names are the snake_case export names (`add_beat`; `addBeat` is a 404);
// - u64 must be a JSON number (a string is a 400); bigints are written as raw digits, so values
//   above 2^53 keep their precision;
// - a reducer's SenderError comes back as HTTP 530 with the message as plain text; bad arguments
//   are a 400; a procedure's string result is a JSON string.
//
// What the module already sent with the dispatch (planner request, photos, topic prefetch) is served
// from the body; only a topic change (setTopic) makes buildLessonRequest go back to the module.
import type { MetricName } from '@tutor/shared';
import type { Transport } from '../../worker/src/transport';
import type { DispatchBody } from './types';

export class ReducerError extends Error {
  constructor(
    readonly reducer: string,
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** The utterance lost the floor (barge-in, newer turn, session over, duplicate run): abort, never repair. */
export const STALE = /is not current|has ended|was not dispatched|not found/;

export const snake = (name: string) => name.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);

/** JSON with bigints as raw integer literals (SpacetimeDB parses u64 exactly). */
export function encodeArgs(args: unknown[]): string {
  return JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? `__u64__${v.toString()}__` : v)).replace(/"__u64__(-?\d+)__"/g, '$1');
}

export interface HttpTransportOptions {
  url: string;
  db: string;
  token: string;
  body: DispatchBody;
  fetch?: typeof fetch;
  /** Called (once) when the module says this utterance is no longer current. */
  onStale?: (message: string) => void;
  timeoutMs?: number;
  now?: () => number;
}

type NotUsed = never;

export class HttpTransport implements Transport {
  /** Round-trip times per reducer (ms), for the dispatch log line. */
  readonly rtts: Array<{ name: string; ms: number; ok: boolean }> = [];
  private stale = false;
  private topicChanged = false;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly o: HttpTransportOptions) {
    this.fetchFn = o.fetch ?? ((...a) => fetch(...a));
    this.now = o.now ?? Date.now;
  }

  get isStale(): boolean {
    return this.stale;
  }

  /** One reducer/procedure call; resolves with the response text. */
  async call(name: string, args: unknown[]): Promise<string> {
    const t0 = this.now();
    let res: Response;
    try {
      res = await this.fetchFn(`${this.o.url.replace(/\/+$/, '')}/v1/database/${encodeURIComponent(this.o.db)}/call/${snake(name)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.o.token}`, 'Content-Type': 'application/json' },
        body: encodeArgs(args),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 8000),
      });
    } catch (e) {
      this.rtts.push({ name, ms: this.now() - t0, ok: false });
      throw new ReducerError(name, 0, `${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    this.rtts.push({ name, ms: this.now() - t0, ok: res.ok });
    if (res.ok) return text;
    const message = text.trim() || `HTTP ${res.status}`;
    if (STALE.test(message) && !this.stale) {
      this.stale = true;
      this.o.onStale?.(message);
    }
    throw new ReducerError(name, res.status, message);
  }

  private async reducer(name: string, args: unknown[]): Promise<void> {
    await this.call(name, args);
  }
  private async procedure(name: string, args: unknown[]): Promise<string> {
    const text = await this.call(name, args);
    const v = JSON.parse(text) as unknown;
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  // ---- reducers LessonRun calls (argument order = the module's reducer signature)
  beginUtterance = (a: { sessionId: bigint; utteranceId: bigint; replyToIdx: number; preemptive: boolean }) => this.reducer('beginUtterance', [a.sessionId, a.utteranceId, a.replyToIdx, a.preemptive]);
  beginOpening = (a: { sessionId: bigint; utteranceId: bigint }) => this.reducer('beginOpening', [a.sessionId, a.utteranceId]);
  addSentence = (a: { sessionId: bigint; utteranceId: bigint; idx: number; display: string; speech: string }) => this.reducer('addSentence', [a.sessionId, a.utteranceId, a.idx, a.display, a.speech]);
  appendTutorTurn = (a: { sessionId: bigint; utteranceId: bigint; text: string; interrupted: boolean }) => this.reducer('appendTutorTurn', [a.sessionId, a.utteranceId, a.text, a.interrupted]);
  recordMetric = (a: { sessionId: bigint; turnIdx: number; name: MetricName; atMicros: bigint }) => this.reducer('recordMetric', [a.sessionId, a.turnIdx, a.name, a.atMicros]);
  beginLesson = (a: { sessionId: bigint; utteranceId: bigint; meta: string }) => this.reducer('beginLesson', [a.sessionId, a.utteranceId, a.meta]);
  addBeat = (a: { sessionId: bigint; utteranceId: bigint; idx: number; visual: string; narration: string }) => this.reducer('addBeat', [a.sessionId, a.utteranceId, a.idx, a.visual, a.narration]);

  // ---- served from the dispatch body
  buildLessonRequest = async (a: { sessionId: bigint; requestId: string }): Promise<string> =>
    this.topicChanged ? this.procedure('buildLessonRequest', [a.sessionId, a.requestId]) : this.o.body.built;
  getSessionImage = async (_a: { sessionId: bigint }) => this.o.body.image;
  getTurnImage = async (_a: { sessionId: bigint; turnIdx: number }) => this.o.body.turnImage;
  prefetchTopic = async (_a: { sessionId: bigint }) =>
    JSON.stringify(this.o.body.topic ?? { ok: true, category: '', concept: '', source: 'session', text: '', hasImage: false });
  setTopic = async (a: { sessionId: bigint; category: string; concept: string }): Promise<string> => {
    const r = await this.procedure('setTopic', [a.sessionId, a.category, a.concept]);
    this.topicChanged = true;
    return r;
  };

  // ---- the tool reply mode is not ported (lesson planner only)
  private unsupported(name: string): Promise<NotUsed> {
    return Promise.reject(new Error(`${name} is not available in the Cloudflare dispatch (lesson mode only)`));
  }
  setPhase = () => this.unsupported('setPhase');
  showBoardItem = () => this.unsupported('showBoardItem');
  clearBoard = () => this.unsupported('clearBoard');
  remember = () => this.unsupported('remember');
  buildContext = () => this.unsupported('buildContext');
  agentHeartbeat = () => this.unsupported('agentHeartbeat');
  submitTutorResult = () => this.unsupported('submitTutorResult');
}
