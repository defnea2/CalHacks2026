// Agent: serves every active session at once. Per-session state lives in SessionAgent, kept in
// a Map keyed by sessionId; there is no global current session, and every call is async, so a
// slow LLM or procedure in one session never blocks another.
//
// The SpacetimeDB adapter (stdb.ts) feeds subscription rows in through the on* methods; tests
// call them directly with a fake Transport and a fake LlmProvider.
import { libraryIndex, OPENING_TURN_IDX, renderPhaseBlock, VOICE_DEFAULTS, type LessonPack, type LlmProvider, type PhraseStatus, type SentenceStatus, type TurnState, type TurnStatus, buildToolSpecs } from '@tutor/shared';
import { buildSystemPrompt } from './prompt';
import { openingLines, ReplyRun, type ReplyDeps } from './reply';
import { prefetchTopic } from './topic';
import { LessonRun, type LessonDeadlines } from './lesson';
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
  /** 'lesson' (default): the team's streaming lesson planner (beats via addBeat);
   *  'tools': the tool-based reply loop (show_board_item(math_canvas), ask_learner, ...). */
  replyMode?: 'lesson' | 'tools';
  /** Lesson mode: 'lesson' (default) = authored lead-in + first lesson as the opening; 'script' = authored opening only. */
  lessonOpening?: 'lesson' | 'script';
  /** Lesson mode: library index + prefetched concept material for the planner (default true). */
  lessonLibrary?: boolean;
  lessonDeadlines?: Partial<LessonDeadlines>;
  /** A ready student turn with no utterance after this long (worker failure) is answered again, once. Default 12 s; 0 = off. */
  stallRetryMs?: number;
}

/** A tutor reply: the tool loop (ReplyRun) or the lesson planner (LessonRun). */
export type Run = ReplyRun | LessonRun;

export interface AgentDeps {
  transport: Transport;
  llm: LlmProvider;
  pack: LessonPack;
  opts: AgentOptions;
  log?: (msg: string) => void;
  /** LLM for lesson mode (own effort setting). Default: llm. */
  lessonLlm?: LlmProvider;
  /** Override the tool set (tests). Default: the registry joined with the pack's tool specs. */
  tools?: ToolDef[];
  now?: () => number;
}

const INTERRUPTED: TurnState = 'interrupted';
const THINKING: TurnState = 'thinking';
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
const MUTATIONS = ['setPhase', 'showBoardItem', 'clearBoard', 'remember', 'setTopic', 'prefetchTopic', 'appendTutorTurn', 'beginLesson', 'addBeat'] as const;
/** Lesson opening: how long the planner request waits for the topic prefetch (the authored lead-in plays meanwhile). */
const OPENING_TOPIC_WAIT_MS = 3500;

export class Agent {
  readonly sessions = new Map<bigint, SessionAgent>();
  readonly router: ToolRouter;
  /** Stable for the whole run (prompt cache); phase instructions go in a separate message. */
  readonly system: string;
  /** Lesson planner library index (system prompt, cache-stable); undefined = library off. */
  readonly libraryIndex?: string;
  private lastUtteranceId = 0n;
  readonly log: (msg: string) => void;
  readonly now: () => number;

  constructor(readonly deps: AgentDeps) {
    this.log = deps.log ?? (m => console.log(m));
    this.now = deps.now ?? Date.now;
    const markers = deps.opts.verifiedSpeech === false;
    this.router = new ToolRouter(deps.tools ?? createToolDefs(deps.pack, undefined, buildToolSpecs(deps.pack, { markers })), deps.opts.toolTimeoutMs);
    // Free-speech rules (speak first, inline markers) only when model text is actually spoken.
    const free = deps.opts.verifiedSpeech === false ? `\n\n${deps.pack.prompts.freeSpeech}` : '';
    this.system = buildSystemPrompt(deps.pack, this.router.specs()) + free;
    if (deps.opts.lessonLibrary !== false) this.libraryIndex = libraryIndex(deps.pack);
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
    // Same id, different session (ids restart at 1 after `--clear` / a republished database).
    const prev = this.sessions.get(row.id)?.row?.startedAt?.microsSinceUnixEpoch;
    if (prev !== undefined && row.startedAt && prev !== row.startedAt.microsSinceUnixEpoch) this.onSessionGone(row.id);
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

  /** Abort everything (shutdown, and on every (re)connect: the subscription re-delivers all rows). */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.onSessionGone(id);
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** process 'unhandledRejection' listener: log instead of Node's default (exit the process). */
export function unhandledRejectionLogger(log: (m: string) => void): (reason: unknown) => void {
  return reason => log(`worker: unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
}

export class SessionAgent {
  row?: SessionRow;
  readonly turns = new Map<number, TurnRow>();
  readonly phrases = new Map<number, PhraseRow>();
  readonly sentences = new Map<string, SentenceRow>();
  /** Reply whose output reaches SpacetimeDB. */
  live?: Run;
  /** Preemptive reply, output held in memory. */
  held?: Run;
  private stallTimer?: ReturnType<typeof setTimeout>;
  private readonly stallRetried = new Set<number>();
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
  /** The opening reply was started (at most once per session and worker). */
  openingStarted = false;
  /** Topic prefetch of this session (started once, with the opening or the first reply). */
  private topicPromise?: Promise<unknown>;
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
    // A photo attached while a preemptive reply is held: that reply would not see it.
    if (this.held && row.pendingPhoto && !prev?.pendingPhoto && !this.held.turnPhoto) {
      this.held.discard('turn photo changed');
      this.held = undefined;
    }
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
    clearTimeout(this.stallTimer);
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
    if (this.wantsOpening()) return this.startOpening();
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

  /** The client asked the tutor to speak first (startConversation: thinking on a session where
   *  nothing was said yet) and no reply is running. All turns must be known (turnCount), and only
   *  open student turns (e.g. noise right after the click) may exist. */
  private wantsOpening(): boolean {
    const r = this.row!;
    if (this.openingStarted || this.live || this.held || r.turnState !== THINKING || r.currentUtteranceId !== 0n) return false;
    if (r.turnCount !== this.turns.size) return false;
    return [...this.turns.values()].every(t => t.role === STUDENT && OPEN_STATUSES.includes(t.status as TurnStatus));
  }

  /** Topic prefetch, once per session, off the critical path (see topic.ts). */
  ensureTopic(): Promise<unknown> {
    const a = this.agent;
    this.topicPromise ??= prefetchTopic({ transport: this.transport(), llm: a.deps.lessonLlm ?? a.deps.llm, pack: a.deps.pack, log: a.log, now: a.now }, this.id).then(r => {
      this.log(`topic ${r.category || '-'}/${r.concept || '-'} (${r.source}, ${r.ms} ms)`);
      return r;
    });
    return this.topicPromise;
  }

  private startOpening(): void {
    this.openingStarted = true;
    if ((this.agent.deps.opts.replyMode ?? 'lesson') === 'lesson') void this.ensureTopic().catch(e => this.log(`topic prefetch failed: ${errText(e)}`));
    this.clearPreemptTimer();
    const run = this.newRun({ idx: OPENING_TURN_IDX, text: '' }, false, true);
    this.log(`opening -> u${run.utteranceId}`);
    if (run.imageIncluded) this.imageSent = true;
    else void run.done.then(() => run.imageIncluded && (this.imageSent = true)).catch(e => this.log(`run u${run.utteranceId} failed: ${errText(e)}`));
    this.live = run;
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
    let run: Run;
    if (held && held.open && held.turnIdx === turn.idx && held.transcript === turn.text && !!held.turnPhoto === !!turn.hasPhoto) {
      run = held;
      run.release(true);
      this.log(`t${turn.idx} ready "${clip(turn.text)}" -> u${run.utteranceId} (preemptive, flushing held output)`);
    } else {
      held?.discard('turn ended with a different transcript');
      run = this.newRun(turn, false);
      this.log(`t${turn.idx} ready "${clip(turn.text)}" -> u${run.utteranceId}`);
    }
    if (run.imageIncluded) this.imageSent = true;
    else void run.done.then(() => run.imageIncluded && (this.imageSent = true)).catch(e => this.log(`run u${run.utteranceId} failed: ${errText(e)}`));
    this.live = run;
    this.armStallWatchdog(turn);
  }

  /** Worker-failure watchdog: the turn is still the latest, still unanswered and no utterance is
   *  speaking for it after stallRetryMs -> answer it again (once per turn). */
  private armStallWatchdog(turn: TurnRow): void {
    const ms = this.agent.deps.opts.stallRetryMs ?? 12_000;
    clearTimeout(this.stallTimer);
    if (!ms || this.stallRetried.has(turn.idx)) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = undefined;
      const latest = this.latestTurn();
      if (this.closed || !this.row?.active || !latest || latest.idx !== turn.idx || latest.status !== READY) return;
      if (this.row.currentUtteranceId !== 0n || [...this.turns.values()].some(t => t.role !== STUDENT && t.idx > turn.idx)) return;
      if (this.live?.open && this.live.llmActive && this.live.turnIdx === turn.idx && this.liveBegan()) return;
      this.stallRetried.add(turn.idx);
      this.log(`t${turn.idx} stalled: no utterance after ${ms} ms, answering again`);
      if (this.live?.open) this.live.interrupt('stall retry');
      this.live = this.newRun(latest, false);
    }, ms);
  }

  /** The live run's utterance reached SpacetimeDB (the session row names it). */
  private liveBegan(): boolean {
    return !!this.live && this.row?.currentUtteranceId === this.live.utteranceId;
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

  /** The turn carries a photo, or one is pending while the turn is still open (preemptive run). */
  private wantsTurnPhoto(idx: number): boolean {
    const t = this.turns.get(idx);
    if (!t || t.role !== STUDENT) return false;
    return !!t.hasPhoto || (!!this.row?.pendingPhoto && OPEN_STATUSES.includes(t.status as TurnStatus));
  }

  private clearPreemptTimer(): void {
    if (this.preemptTimer) clearTimeout(this.preemptTimer);
    this.preemptTimer = undefined;
  }

  private newRun(turn: { idx: number; text: string }, held: boolean, opening = false): Run {
    const a = this.agent;
    // The opening stays the authored script (no LLM, ~0.5 s to audio; measured 2.8 s as a generated
    // lesson, and the learner usually answers it); lessons start with the first student turn.
    const lessonMode = (a.deps.opts.replyMode ?? 'lesson') === 'lesson';
    const task = this.row?.taskText.trim() ?? '';
    // Lesson opening (LESSON_OPENING=lesson, default): the authored lead-in, then the first lesson in
    // the same utterance; the planner's latency hides behind the lead-in. Needs a task to teach.
    const leadIn = a.deps.pack.prompts.openingLessonScript;
    const lessonOpening = opening && lessonMode && a.deps.opts.lessonOpening !== 'script' && a.deps.opts.verifiedSpeech !== false && !!leadIn && (!!task || !!this.row?.hasImage);
    const authoredOpening = opening && !lessonOpening && a.deps.opts.verifiedSpeech !== false && !!a.deps.pack.prompts.openingScript;
    if (lessonMode && !authoredOpening) {
      return new LessonRun(
        { transport: this.transport(), llm: a.deps.lessonLlm ?? a.deps.llm, log: a.log, now: a.now, deadlines: a.deps.opts.lessonDeadlines, libraryIndex: a.libraryIndex },
        {
          sessionId: this.id,
          turnIdx: turn.idx,
          opening,
          transcript: turn.text,
          utteranceId: a.nextUtteranceId(),
          wantImage: !this.imageSent && !!this.row?.hasImage,
          turnPhoto: this.wantsTurnPhoto(turn.idx),
          held,
          prelude: lessonOpening ? openingLines(leadIn!, task) : undefined,
          // Only the opening waits (its lead-in covers it); later turns never wait on the critical path.
          topicReady: this.ensureTopic(),
          topicWaitMs: lessonOpening ? OPENING_TOPIC_WAIT_MS : 0,
        }
      );
    }
    const deps: ReplyDeps = {
      transport: this.transport(),
      llm: a.deps.llm,
      router: a.router,
      system: a.system,
      phaseBlock: (phase, changed) => renderPhaseBlock(a.deps.pack, phase, changed),
      openingPrompt: a.deps.pack.prompts.opening,
      openingScript: a.deps.pack.prompts.openingScript,
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
      opening,
      phase: () => this.row?.phase ?? a.deps.pack.initialPhase,
      transcript: turn.text,
      taskText: this.row?.taskText ?? '',
      utteranceId: a.nextUtteranceId(),
      turns: () => [...this.turns.values()],
      wantImage: !this.imageSent && !!this.row?.hasImage,
      held,
    });
  }
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
