// Agent: serves every active session at once. Per-session state lives in SessionAgent, kept in
// a Map keyed by sessionId; there is no global current session, and every call is async, so a
// slow LLM or procedure in one session never blocks another.
//
// The SpacetimeDB adapter (stdb.ts) feeds subscription rows in through the on* methods; tests
// call them directly with a fake Transport and a fake LlmProvider.
import { VOICE_DEFAULTS, type LessonPack, type LlmProvider, type PhraseStatus, type SentenceStatus, type TurnState, type TurnStatus } from '@tutor/shared';
import { buildSystemPrompt } from './prompt';
import { ReplyRun, type ReplyDeps } from './reply';
import { ToolRouter } from './router';
import { createToolDefs } from './tools/index';
import type { ToolDef } from './tools/types';
import type { PhraseRow, SentenceRow, SessionRow, Transport, TurnRow } from './transport';

export interface AgentOptions {
  preemptive: boolean;
  /** Silence after the end of speech before a preemptive reply starts. */
  preemptiveSilenceMs: number;
  /** How long after the end of speech a phrase's final chunk arrives (the client's phrase
   *  silence window). Default VOICE_DEFAULTS.VAD_PHRASE_MS. */
  phraseSilenceMs?: number;
  /** Max age of a prefetched context that may still be reused. Default 10 s. */
  contextTtlMs?: number;
  maxToolRounds: number;
  recentTurns: number;
  toolTimeoutMs: number;
  /** Default true. False is reserved for transport tests using scripted prose. */
  verifiedSpeech?: boolean;
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
const STREAMING: PhraseStatus = 'streaming';
const TRANSCRIBING: PhraseStatus = 'transcribing';
const CLOSING: TurnStatus = 'closing';
const DEFAULT_CONTEXT_TTL_MS = 10_000;
/** Transport calls that change what buildContext returns (board, phase, topic, memory). */
const MUTATIONS = ['setPhase', 'showBoardItem', 'clearBoard', 'remember', 'setTopic', 'appendTutorTurn'] as const;

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

  /** A pushAudio chunk arrived. phraseId lets the agent tell a phrase's final chunk (the
   *  phrase row is already `transcribing`) from ongoing speech. */
  onSpeechActivity(sessionId: bigint, phraseId?: number): void {
    this.sessions.get(sessionId)?.speechActivity(phraseId);
  }

  /** A board item of the session changed (context prefetch is then stale). */
  onBoardItem(sessionId: bigint): void {
    this.sessions.get(sessionId)?.contextChanged();
  }

  /** A learner row changed: every session's prefetched context is stale. */
  onLearner(): void {
    for (const s of this.sessions.values()) s.contextChanged();
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
  /** Estimated end of the student's latest speech (local clock). For a phrase-final chunk
   *  this is the arrival time minus the phrase silence window. */
  lastSpeechAt = 0;
  /** Bumped on anything that changes buildContext's result. */
  private ctxVersion = 0;
  private ctxKey = '';
  private ctxCache?: { version: number; at: number; promise: Promise<string> };
  private transportView?: AgentDeps['transport'];
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
    const key = [row.phase, row.category, row.concept, row.taskText, row.hasImage, row.learnerId].map(String).join('\u0000');
    if (key !== this.ctxKey) {
      this.ctxKey = key;
      this.contextChanged();
    }
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
    // A phrase that turns `transcribing` just got its final chunk, sent one phrase window after
    // the speech ended. Order-independent with the speech_activity event of the same commit.
    const ended = row.status === TRANSCRIBING && (!prev || prev.status === STREAMING);
    if (ended && !this.otherPhraseStreaming(row)) this.lastSpeechAt = this.phraseEndAt();
    else if (!prev) this.lastSpeechAt = this.agent.now();
    this.evaluate();
  }

  setSentence(row: SentenceRow): void {
    this.sentences.set(`${row.utteranceId}:${row.idx}`, row);
  }

  speechActivity(phraseId?: number): void {
    const p = phraseId === undefined ? undefined : this.phrases.get(phraseId);
    // Final chunk: the phrase row (same commit) is already `transcribing`.
    const final = !!p && p.status === TRANSCRIBING && !this.otherPhraseStreaming(p);
    this.lastSpeechAt = final ? this.phraseEndAt() : this.agent.now();
    this.clearPreemptTimer();
    if (this.held) {
      this.held.discard('student spoke again');
      this.held = undefined;
    }
  }

  /** Something buildContext reads changed: a prefetched context must not be reused. */
  contextChanged(): void {
    this.ctxVersion++;
    this.ctxCache = undefined;
  }

  private phraseEndAt(): number {
    return this.agent.now() - (this.agent.deps.opts.phraseSilenceMs ?? VOICE_DEFAULTS.VAD_PHRASE_MS);
  }

  /** Another phrase of the same turn is still streaming (the student is already speaking again). */
  private otherPhraseStreaming(of: PhraseRow): boolean {
    for (const p of this.phrases.values()) if (p.phraseId !== of.phraseId && p.turnIdx === of.turnIdx && p.status === STREAMING) return true;
    return false;
  }

  /** Context for the next reply: the prefetched one while nothing relevant changed, else fresh. */
  context(): Promise<string> {
    const ttl = this.agent.deps.opts.contextTtlMs ?? DEFAULT_CONTEXT_TTL_MS;
    const c = this.ctxCache;
    if (c && c.version === this.ctxVersion && this.agent.now() - c.at <= ttl) return c.promise;
    const version = this.ctxVersion;
    const promise = this.agent.deps.transport.buildContext({ sessionId: this.id });
    const entry = { version, at: this.agent.now(), promise };
    this.ctxCache = entry;
    promise.catch(() => {
      if (this.ctxCache === entry) this.ctxCache = undefined;
    });
    return promise;
  }

  /** Starts building the context early (turn closing) so the reply finds it ready. */
  prefetchContext(): void {
    if (this.live?.open) return; // a running reply may still change board/phase
    this.context().catch(() => undefined);
  }

  /** The transport replies use: buildContext goes through the prefetch cache, and every call
   *  that changes the context invalidates it (at start and at completion). */
  private transport(): AgentDeps['transport'] {
    if (this.transportView) return this.transportView;
    const base = this.agent.deps.transport;
    const view: AgentDeps['transport'] = Object.create(base);
    view.buildContext = () => this.context();
    for (const name of MUTATIONS) {
      const fn = base[name] as (a: never) => Promise<unknown>;
      (view as unknown as Record<string, unknown>)[name] = (a: never) => {
        this.contextChanged();
        return fn.call(base, a).finally(() => this.contextChanged());
      };
    }
    return (this.transportView = view);
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
      if (latest.status === CLOSING && latest.idx > this.handledIdx && !this.held) this.prefetchContext();
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
      transport: this.transport(),
      llm: a.deps.llm,
      router: a.router,
      system: a.system,
      maxToolRounds: a.deps.opts.maxToolRounds,
      recentTurns: a.deps.opts.recentTurns,
      verifiedSpeech: a.deps.opts.verifiedSpeech,
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
