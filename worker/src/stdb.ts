// SpacetimeDB side of the worker: the connection (identity token, registerAgent on every
// connect, reconnect with backoff), the subscriptions across all sessions, and the Transport
// implementation on top of the generated bindings.
import fs from 'node:fs';
import { DbConnection } from './module_bindings/index';
import type { Agent } from './agent';
import type { TutorRequests } from './tutorRequests';
import type { Transport } from './transport';

export interface StdbOptions {
  uri: string;
  db: string;
  agentSecret: string;
  tokenFile: string;
  /** Token from the environment (AGENT_TOKEN) wins over the file. */
  token?: string;
  log?: (msg: string) => void;
}

/** Everything the worker reads. All sessions: the worker serves them concurrently. */
export const SUBSCRIPTIONS = [
  'SELECT * FROM session WHERE active = true',
  'SELECT * FROM turn',
  'SELECT * FROM phrase',
  'SELECT * FROM reply_sentence',
  'SELECT * FROM board_item',
  'SELECT * FROM learner',
  'SELECT * FROM speech_activity',
  'SELECT * FROM playback_flush',
  "SELECT * FROM tutor_request WHERE status = 'pending'",
];

function readToken(file: string): string | undefined {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

function writeToken(file: string, token: string): void {
  try {
    fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  } catch {
    /* not fatal: a new identity registers again with AGENT_SECRET */
  }
}

/** Transport over the current connection. Calls while disconnected reject. */
export class StdbTransport implements Transport {
  conn?: DbConnection;

  private c(): DbConnection {
    if (!this.conn) throw new Error('not connected to SpacetimeDB');
    return this.conn;
  }
  async beginUtterance(a: Parameters<Transport['beginUtterance']>[0]) {
    return this.c().reducers.beginUtterance(a);
  }
  async beginOpening(a: Parameters<Transport['beginOpening']>[0]) {
    return this.c().reducers.beginOpening(a);
  }
  async addSentence(a: Parameters<Transport['addSentence']>[0]) {
    return this.c().reducers.addSentence(a);
  }
  async appendTutorTurn(a: Parameters<Transport['appendTutorTurn']>[0]) {
    return this.c().reducers.appendTutorTurn(a);
  }
  async recordMetric(a: Parameters<Transport['recordMetric']>[0]) {
    return this.c().reducers.recordMetric(a);
  }
  async setPhase(a: Parameters<Transport['setPhase']>[0]) {
    return this.c().reducers.setPhase(a);
  }
  async showBoardItem(a: Parameters<Transport['showBoardItem']>[0]) {
    return this.c().reducers.showBoardItem(a);
  }
  async clearBoard(a: Parameters<Transport['clearBoard']>[0]) {
    return this.c().reducers.clearBoard(a);
  }
  async remember(a: Parameters<Transport['remember']>[0]) {
    return this.c().reducers.remember(a);
  }
  async buildContext(a: { sessionId: bigint }) {
    return this.c().procedures.buildContext(a);
  }
  async setTopic(a: Parameters<Transport['setTopic']>[0]) {
    return this.c().procedures.setTopic(a);
  }
  async getSessionImage(a: { sessionId: bigint }) {
    return this.c().procedures.getSessionImage(a);
  }
  async buildLessonRequest(a: { sessionId: bigint; requestId: string }) {
    return this.c().procedures.buildLessonRequest(a);
  }
  async prefetchTopic(a: { sessionId: bigint }) {
    return this.c().procedures.prefetchTopic(a);
  }
  async beginLesson(a: Parameters<Transport['beginLesson']>[0]) {
    return this.c().reducers.beginLesson(a);
  }
  async addBeat(a: Parameters<Transport['addBeat']>[0]) {
    return this.c().reducers.addBeat(a);
  }
  async agentHeartbeat(a: Parameters<Transport['agentHeartbeat']>[0]) {
    return this.c().reducers.agentHeartbeat(a);
  }
  async submitTutorResult(a: Parameters<Transport['submitTutorResult']>[0]) {
    return this.c().reducers.submitTutorResult(a);
  }
}

/** Connects, wires subscriptions into the agent, reconnects forever with backoff. */
export class StdbLink {
  readonly transport = new StdbTransport();
  private stopped = false;
  private failures = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly log: (msg: string) => void;
  private agent?: Agent;
  private tutor?: TutorRequests;

  constructor(private readonly o: StdbOptions) {
    this.log = o.log ?? (m => console.log(m));
  }

  start(agent: Agent, tutor?: TutorRequests): void {
    this.agent = agent;
    this.tutor = tutor;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.transport.conn?.disconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    this.failures++;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(this.failures, 5));
    this.log(`[stdb] reconnecting in ${delay} ms`);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, delay);
  }

  private connect(): void {
    const agent = this.agent!;
    // After repeated failures with a stored token, try a fresh identity (e.g. wiped server data).
    const token = this.failures >= 3 ? undefined : (this.o.token ?? readToken(this.o.tokenFile));
    DbConnection.builder()
      .withUri(this.o.uri)
      .withDatabaseName(this.o.db)
      .withToken(token)
      // Updates without waiting for durability (~5.5 ms per hop, docs/latency-internal.md).
      .withConfirmedReads(false)
      .onConnect((conn, identity, newToken) => {
        this.failures = 0;
        this.transport.conn = conn;
        if (!this.o.token) writeToken(this.o.tokenFile, newToken);
        this.log(`[stdb] connected to ${this.o.uri}/${this.o.db} as ${identity.toHexString().slice(0, 12)}…`);
        conn.reducers
          .registerAgent({ secret: this.o.agentSecret })
          .then(() => this.log('[stdb] registered as agent'))
          .catch(e => this.log(`[stdb] registerAgent failed: ${e instanceof Error ? e.message : String(e)}`));
        // Fresh per-session state: after a reconnect or a cleared database (session ids restart
        // at 1) a reused SessionAgent would hold stale turns/utterances and stay silent.
        agent.closeAll();
        this.wire(conn, agent);
      })
      .onConnectError((_ctx, err) => {
        this.log(`[stdb] connect error: ${err?.message ?? err}`);
        if (this.transport.conn) this.transport.conn = undefined;
        this.scheduleReconnect();
      })
      .onDisconnect((_ctx, err) => {
        this.log(`[stdb] disconnected${err ? `: ${err.message}` : ''}`);
        this.transport.conn = undefined;
        this.scheduleReconnect();
      })
      .build();
  }

  private wire(conn: DbConnection, agent: Agent): void {
    const db = conn.db;
    db.session.onInsert((_c, r) => agent.onSession(r));
    db.session.onUpdate((_c, _old, r) => agent.onSession(r));
    db.session.onDelete((_c, r) => agent.onSessionGone(r.id));
    db.turn.onInsert((_c, r) => agent.onTurn(r));
    db.turn.onUpdate((_c, _old, r) => agent.onTurn(r));
    db.phrase.onInsert((_c, r) => agent.onPhrase(r));
    db.phrase.onUpdate((_c, _old, r) => agent.onPhrase(r));
    db.replySentence.onInsert((_c, r) => agent.onSentence(r));
    db.replySentence.onUpdate((_c, _old, r) => agent.onSentence(r));
    db.speechActivity.onInsert((_c, r) => agent.onSpeechActivity(r.sessionId, r.phraseId));
    db.boardItem.onInsert((_c, r) => agent.onBoardItem(r.sessionId));
    db.boardItem.onUpdate((_c, _old, r) => agent.onBoardItem(r.sessionId));
    db.boardItem.onDelete((_c, r) => agent.onBoardItem(r.sessionId));
    db.learner.onUpdate(() => agent.onLearner());
    db.playbackFlush.onInsert((_c, r) => agent.onPlaybackFlush(r.sessionId, r.utteranceId));
    db.tutorRequest.onInsert((_c, r) => this.tutor?.onRequest(r));
    conn
      .subscriptionBuilder()
      .onApplied(() => this.log(`[stdb] subscribed (${[...agent.sessions.values()].filter(s => s.row).length} active sessions)`))
      .onError(ctx => this.log(`[stdb] subscription error: ${String((ctx as { event?: unknown }).event ?? "")}`))
      .subscribe(SUBSCRIPTIONS);
  }
}
