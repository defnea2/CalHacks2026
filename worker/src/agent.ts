// Agent: serves every active session at once. Per-session state lives in SessionAgent, kept in
// a Map keyed by sessionId; there is no global current session, and every call is async, so a
// slow LLM or procedure in one session never blocks another.
//
// The SpacetimeDB adapter (stdb.ts) feeds subscription rows in through the on* methods; tests
// call them directly with a fake Transport and a fake LlmProvider.
import type { LessonPack, LlmProvider, PhraseStatus, SentenceStatus, TurnState, TurnStatus } from '@tutor/shared';
import { buildSystemPrompt } from './prompt';
import { ReplyRun, type ReplyDeps } from './reply';
import { ToolRouter } from './router';
import { createToolDefs } from './tools/index';
import type { ToolDef } from './tools/types';
import type { PhraseRow, SentenceRow, SessionRow, Transport, TurnRow } from './transport';

export interface AgentOptions {
  preemptive: boolean;
  preemptiveSilenceMs: number;
  maxToolRounds: number;
  recentTurns: number;
  toolTimeoutMs: number;
}

export interface AgentDeps {
  transport: Transport;
  llm: LlmProvider;
  pack: LessonPack;
  opts: AgentOptions;
  log?: (msg: string) => void;
  /** Override the tool set (tests). Default: the registry joined with the pack's tool specs. */
  tools?: ToolDef[];
  now?: () => number;
}

const INTERRUPTED: TurnState = 'interrupted';
const READY: TurnStatus = 'ready';
const OPEN_STATUSES: readonly TurnStatus[] = ['open', 'closing'];
const BUSY_PHRASES: readonly PhraseStatus[] = ['streaming', 'transcribing'];
const DROPPED: SentenceStatus = 'dropped';
const STUDENT = 'student';

export class Agent {
  readonly sessions = new Map<bigint, SessionAgent>();
  readonly router: ToolRouter;
  readonly system: string;
  private lastUtteranceId = 0n;
  readonly log: (msg: string) => void;
  readonly now: () => number;

  constructor(readonly deps: AgentDeps) {
    this.log = deps.log ?? (m => console.log(m));
    this.now = deps.now ?? Date.now;
    this.router = new ToolRouter(deps.tools ?? createToolDefs(deps.pack), deps.opts.toolTimeoutMs);
    this.system = buildSystemPrompt(deps.pack, this.router.specs());
  }

  /** Unique u64 per utterance: ms timestamp * 1000 + counter, strictly increasing. */
  nextUtteranceId(): bigint {
    let id = BigInt(this.now()) * 1000n;
    if (id <= this.lastUtteranceId) id = this.lastUtteranceId + 1n;
    this.lastUtteranceId = id;
    return id;
  }

  session(id: bigint): SessionAgent {
    let s = this.sessions.get(id);
    if (!s) {
      s = new SessionAgent(this, id);
      this.sessions.set(id, s);
    }
    return s;
  }

  // ------------------------------------------------------------------ subscription input

  onSession(row: SessionRow): void {
    if (!row.active) return this.onSessionGone(row.id);
    this.session(row.id).setSession(row);
  }

  onSessionGone(id: bigint): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.close();
    this.sessions.delete(id);
  }

  onTurn(row: TurnRow): void {
    this.session(row.sessionId).setTurn(row);
  }

  onPhrase(row: PhraseRow): void {
    this.session(row.sessionId).setPhrase(row);
  }

  onSentence(row: SentenceRow): void {
    this.session(row.sessionId).setSentence(row);
  }

  onSpeechActivity(sessionId: bigint): void {
    this.sessions.get(sessionId)?.speechActivity();
  }

  onPlaybackFlush(sessionId: bigint, utteranceId: bigint): void {
    this.sessions.get(sessionId)?.playbackFlush(utteranceId);
  }

  /** Abort everything (shutdown). */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.onSessionGone(id);
  }
}

export class SessionAgent {
  row?: SessionRow;
  readonly turns = new Map<number, TurnRow>();
  readonly phrases = new Map<number, PhraseRow>();
  readonly sentences = new Map<string, SentenceRow>();
  /** Reply whose output reaches SpacetimeDB. */
  live?: ReplyRun;
  /** Preemptive reply, output held in memory. */
  held?: ReplyRun;
  /** Highest student turn idx a reply was started for. */
  handledIdx = -1;
  lastSpeechAt = 0;
  imageSent = false;
  private preemptTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private readonly agent: Agent,
    readonly id: bigint
  ) {}

  private log(msg: string) {
    this.agent.log(`[s${this.id}] ${msg}`);
  }

  // ------------------------------------------------------------------ row updates

  setSession(row: SessionRow): void {
    const prev = this.row;
    this.row = row;
    if (row.turnState === INTERRUPTED && prev?.turnState !== INTERRUPTED) this.live?.interrupt('barge-in');
    this.evaluate();
  }

  setTurn(row: TurnRow): void {
    this.turns.set(row.idx, row);
    this.evaluate();
  }

  setPhrase(row: PhraseRow): void {
    const prev = this.phrases.get(row.phraseId);
    this.phrases.set(row.phraseId, row);
    if (!prev) this.lastSpeechAt = this.agent.now();
    this.evaluate();
  }

  setSentence(row: SentenceRow): void {
    this.sentences.set(`${row.utteranceId}:${row.idx}`, row);
  }

  speechActivity(): void {
    this.lastSpeechAt = this.agent.now();
    this.clearPreemptTimer();
    if (this.held) {
      this.held.discard('student spoke again');
      this.held = undefined;
    }
  }

  playbackFlush(utteranceId: bigint): void {
    if (this.live && this.live.utteranceId === utteranceId) this.live.interrupt('playback flushed');
  }

  close(): void {
    this.closed = true;
    this.clearPreemptTimer();
    this.held?.discard('session ended');
    this.held = undefined;
    // Session is over: stop the LLM; nothing more to record.
    if (this.live?.open) this.live.interrupt('session ended');
  }

  // ------------------------------------------------------------------ decisions

  latestTurn(): TurnRow | undefined {
    let best: TurnRow | undefined;
    for (const t of this.turns.values()) if (!best || t.idx > best.idx) best = t;
    return best;
  }

  /** Re-checks what to do after any change: answer a ready turn, keep/drop a held reply,
   *  arm the preemptive timer. Idempotent. */
  evaluate(): void {
    if (this.closed || !this.row?.active) return;
    const latest = this.latestTurn();
    if (!latest || latest.role !== STUDENT) {
      this.clearPreemptTimer();
      this.dropHeldIfStale(latest);
      return;
    }
    if (latest.status === READY) {
      if (latest.idx > this.handledIdx) this.answer(latest);
      return;
    }
    if (OPEN_STATUSES.includes(latest.status as TurnStatus)) {
      this.dropHeldIfStale(latest);
      this.armPreemptive(latest);
    }
  }

  private dropHeldIfStale(latest: TurnRow | undefined): void {
    if (!this.held) return;
    if (latest && latest.role === STUDENT && latest.idx === this.held.turnIdx && latest.text === this.held.transcript) return;
    this.held.discard('transcript changed');
    this.held = undefined;
  }

  private answer(turn: TurnRow): void {
    this.handledIdx = turn.idx;
    this.clearPreemptTimer();
    if (this.live?.open) this.live.interrupt('newer student turn');
    const held = this.held;
    this.held = undefined;
    let run: ReplyRun;
    if (held && held.open && held.turnIdx === turn.idx && held.transcript === turn.text) {
      run = held;
      run.release(true);
      this.log(`t${turn.idx} ready "${clip(turn.text)}" -> u${run.utteranceId} (preemptive, flushing held output)`);
    } else {
      held?.discard('turn ended with a different transcript');
      run = this.newRun(turn, false);
      this.log(`t${turn.idx} ready "${clip(turn.text)}" -> u${run.utteranceId}`);
    }
    if (run.imageIncluded) this.imageSent = true;
    else void run.done.then(() => run.imageIncluded && (this.imageSent = true));
    this.live = run;
  }

  private armPreemptive(turn: TurnRow): void {
    const o = this.agent.deps.opts;
    const ok = () =>
      o.preemptive &&
      !this.held &&
      !this.live?.llmActive &&
      turn.text.trim() !== '' &&
      ![...this.phrases.values()].some(p => p.turnIdx === turn.idx && BUSY_PHRASES.includes(p.status as PhraseStatus));
    if (!ok()) return this.clearPreemptTimer();
    const wait = Math.max(0, o.preemptiveSilenceMs - (this.agent.now() - this.lastSpeechAt));
    this.clearPreemptTimer();
    this.preemptTimer = setTimeout(() => {
      this.preemptTimer = undefined;
      const latest = this.latestTurn();
      if (this.closed || !latest || latest.idx !== turn.idx || latest.text !== turn.text || !OPEN_STATUSES.includes(latest.status as TurnStatus)) return;
      if (this.agent.now() - this.lastSpeechAt < o.preemptiveSilenceMs) return this.armPreemptive(latest);
      if (!ok()) return;
      this.held = this.newRun(latest, true);
      this.log(`t${latest.idx} preemptive start on "${clip(latest.text)}"`);
    }, wait);
  }

  private clearPreemptTimer(): void {
    if (this.preemptTimer) clearTimeout(this.preemptTimer);
    this.preemptTimer = undefined;
  }

  private newRun(turn: TurnRow, held: boolean): ReplyRun {
    const a = this.agent;
    const deps: ReplyDeps = {
      transport: a.deps.transport,
      llm: a.deps.llm,
      router: a.router,
      system: a.system,
      maxToolRounds: a.deps.opts.maxToolRounds,
      recentTurns: a.deps.opts.recentTurns,
      log: a.log,
      now: a.now,
      isDropped: (u, i) => this.sentences.get(`${u}:${i}`)?.status === DROPPED,
    };
    return new ReplyRun(deps, {
      sessionId: this.id,
      turnIdx: turn.idx,
      transcript: turn.text,
      utteranceId: a.nextUtteranceId(),
      turns: () => [...this.turns.values()],
      wantImage: !this.imageSent && !!this.row?.hasImage,
      held,
    });
  }
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
