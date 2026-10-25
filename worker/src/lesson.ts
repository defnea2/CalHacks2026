// LessonRun: the team's streaming lesson planner as a reply mode (port of src/server/anthropicModel.ts
// + teachingPlugin.ts, without the Vite server). One tutor reply = one lesson step:
//
//   buildLessonRequest (module procedure: authoritative ModelRequest)
//   -> Claude streams {"meta":{...},"moments":[...]} (team prompt, thinking off)
//   -> LessonStreamParser (team code, incremental JSON) releases each moment as soon as the next
//      `,` proves it complete -> beginLesson (meta) / addBeat (moment) reducers; the module
//      compiles + validates it against canvas_state and queues its sentences for TTS.
//   -> on `]` the parser validates the whole lesson (fillers, check prompt) and the final moment
//      goes out with final:true.
//
// The worker decides nothing about lesson flow: every accept/reject comes from the module.
// Failures follow the team contract: before anything was spoken one repair round with the
// validator message; after that the lesson is truncated and closed with a recap beat that carries
// the check. Deadlines: first token, total, stall after the first beat. Output goes through an
// ordered outbox behind a gate, like ReplyRun, so a preemptive run holds everything until release().
import { LEARNER_QUESTIONS, prepareSentence, type ChatMessage, type LlmProvider, type MetricName } from '@tutor/shared';
import { FILLERS, LessonStreamParser } from '@tutor/teaching/server/streamingLesson';
import { normalizePrompt, plannerSystem, plannerUserMessage, recentCheckPrompts } from '@tutor/teaching/server/plannerPrompt';
import type { ModelRequest } from '@tutor/teaching/server/planning';
import type { PlanningProgress } from '@tutor/teaching/teaching/streaming';
import { validatorMessage } from '@tutor/teaching/teaching/lessonFlow';
import { choiceProblem, homeworkRepeat } from '@tutor/teaching/teaching/checkGuards';
import type { TeachingCheck } from '@tutor/teaching/teaching/contracts';
import type { Transport } from './transport';

export const RECAP_NARRATION = 'Look at the whole picture once more.';
export interface LessonDeadlines {
  /** No token within this time: the attempt is retried once (nothing was released yet). */
  firstTokenMs: number;
  /** Whole lesson (team: 45 s). */
  totalMs: number;
  /** After the first beat: no new output for this long -> truncate + recap (team: 15 s). */
  stallMs: number;
}
export const DEFAULT_DEADLINES: LessonDeadlines = { firstTokenMs: 9000, totalMs: 45_000, stallMs: 15_000 };

export interface LessonDeps {
  transport: Transport;
  llm: LlmProvider;
  log: (msg: string) => void;
  now?: () => number;
  deadlines?: Partial<LessonDeadlines>;
  /** Library index for the planner system prompt (cache-stable); absent = no library. */
  libraryIndex?: string;
}

export interface LessonParams {
  sessionId: bigint;
  turnIdx: number;
  opening?: boolean;
  transcript: string;
  utteranceId: bigint;
  wantImage: boolean;
  /** The learner sent a photo with this turn (or one is pending while it is open): getTurnImage. */
  turnPhoto?: boolean;
  held: boolean;
  /** Authored lines spoken first in the same utterance (lesson opening), while the lesson is planned. */
  prelude?: string[];
  /** Topic prefetch in flight: waited for (at most topicWaitMs) before the planner request. */
  topicReady?: Promise<unknown>;
  topicWaitMs?: number;
}

export type LessonState = 'held' | 'live' | 'finished' | 'interrupted' | 'discarded' | 'failed';

/** Counters for the latency / rejection report (also logged per lesson). */
export interface LessonStats {
  attempts: number;
  repairs: number;
  /** Validator errors before anything was spoken (parser or module), per attempt. */
  rejectedBeforeSpeech: string[];
  /** Module rejections of released beats. */
  beatRejections: string[];
  recap: boolean;
  beats: number;
  firstBeatMs: number | null;
  firstTokenMs: number | null;
}

class Rejected extends Error {}

export class LessonRun {
  readonly sessionId: bigint;
  readonly turnIdx: number;
  readonly transcript: string;
  readonly utteranceId: bigint;
  readonly opening: boolean;
  state: LessonState;
  llmActive = true;
  imageIncluded = false;
  /** Asked for the turn photo (agent compares it with turn.hasPhoto before reusing a held run). */
  readonly turnPhoto: boolean;
  /** Data URL of the turn photo, '' = none. */
  private turnImage = '';
  preemptive = false;
  /** Narrations of the beats the module accepted, in order. */
  readonly sent: string[] = [];
  /** Authored prelude lines spoken before the beats. */
  readonly preludeSent: string[] = [];
  readonly stats: LessonStats = { attempts: 0, repairs: 0, rejectedBeforeSpeech: [], beatRejections: [], recap: false, beats: 0, firstBeatMs: null, firstTokenMs: null };
  readonly done: Promise<void>;

  private readonly abort = new AbortController();
  private round?: AbortController;
  private releaseGate!: () => void;
  private readonly gate = new Promise<void>(r => (this.releaseGate = r));
  private chain: Promise<unknown>;
  private released = false;
  private began = false;
  private closed = false;
  private began_lesson = false;
  /** Beats queued to the module in this attempt (index of the next one). */
  private queued = 0;
  private rejection?: string;
  private finishing = false;
  private firstTokenAt = 0;
  private firstTokenRecorded = false;
  private readonly startedAt: number;
  private library: unknown = null;
  /** Prefetched topic of the request (log). */
  topic = '';
  private readonly now: () => number;
  private readonly deadlines: LessonDeadlines;

  constructor(
    private readonly deps: LessonDeps,
    private readonly p: LessonParams
  ) {
    this.sessionId = p.sessionId;
    this.turnIdx = p.turnIdx;
    this.transcript = p.transcript;
    this.utteranceId = p.utteranceId;
    this.opening = !!p.opening;
    this.turnPhoto = !!p.turnPhoto && !p.opening;
    this.state = p.held ? 'held' : 'live';
    this.now = deps.now ?? Date.now;
    this.deadlines = { ...DEFAULT_DEADLINES, ...deps.deadlines };
    this.startedAt = this.now();
    this.chain = this.gate.then(() => this.begin());
    this.done = this.main();
    if (!p.held) this.release(false);
  }

  get aborted(): boolean {
    return this.abort.signal.aborted;
  }
  get open(): boolean {
    return this.state === 'held' || this.state === 'live';
  }

  release(preemptive: boolean): void {
    if (this.released || this.aborted) return;
    this.released = true;
    this.preemptive = preemptive;
    this.state = 'live';
    this.releaseGate();
  }

  discard(why = ''): void {
    if (this.released) return this.interrupt(why);
    if (!this.open) return;
    this.state = 'discarded';
    this.abort.abort();
    this.round?.abort();
    this.releaseGate();
    this.log(`discarded preemptive lesson${why ? ` (${why})` : ''}`);
  }

  interrupt(why = ''): void {
    if (!this.released) return this.discard(why);
    if (!this.open) return;
    this.state = 'interrupted';
    this.abort.abort();
    this.round?.abort();
    void this.close(true, why);
  }

  // ------------------------------------------------------------------ internals

  private log(msg: string) {
    this.deps.log(`[s${this.sessionId} ${this.opening ? 'opening' : `t${this.turnIdx}`} u${this.utteranceId} lesson] ${msg}`);
  }

  private metric(name: MetricName, atMs: number) {
    this.deps.transport
      .recordMetric({ sessionId: this.sessionId, turnIdx: this.turnIdx, name, atMicros: BigInt(Math.round(atMs)) * 1000n })
      .catch(e => this.log(`recordMetric ${name} failed: ${errText(e)}`));
  }

  private markFirstToken() {
    if (this.firstTokenAt) return;
    this.firstTokenAt = this.now();
    this.stats.firstTokenMs = this.firstTokenAt - this.startedAt;
    if (this.began) this.recordFirstToken();
  }
  private recordFirstToken() {
    if (this.firstTokenRecorded || !this.firstTokenAt) return;
    this.firstTokenRecorded = true;
    this.metric('llmFirstTokenAt', this.firstTokenAt);
  }

  private async begin(): Promise<void> {
    if (this.aborted) return;
    try {
      if (this.opening) await this.deps.transport.beginOpening({ sessionId: this.sessionId, utteranceId: this.utteranceId });
      else await this.deps.transport.beginUtterance({ sessionId: this.sessionId, utteranceId: this.utteranceId, replyToIdx: this.turnIdx, preemptive: this.preemptive });
      this.began = true;
      this.recordFirstToken();
    } catch (e) {
      this.log(`beginUtterance failed: ${errText(e)}`);
      this.state = 'failed';
      this.abort.abort();
      this.round?.abort();
    }
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const p = this.chain.then(() => (this.aborted ? undefined : op()));
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** A module rejection stops the current round: nothing after it may be spoken. */
  private reject(what: string, e: unknown) {
    if (this.rejection) return;
    this.rejection = `${what}: ${errText(e)}`;
    this.log(`rejected ${this.rejection}`);
    this.round?.abort();
  }

  private sendMeta(parser: LessonStreamParser) {
    if (this.began_lesson) return;
    this.began_lesson = true;
    const meta = JSON.stringify(parser.lessonMeta);
    void this.enqueue(async () => {
      if (this.rejection) return;
      try {
        await this.deps.transport.beginLesson({ sessionId: this.sessionId, utteranceId: this.utteranceId, meta });
      } catch (e) {
        this.began_lesson = false;
        this.reject('beginLesson', e);
      }
    });
  }

  /** Queues moment `index` (compact form; the module recompiles it). */
  private sendBeat(index: number, moment: { narration: string; [k: string]: unknown }, final: boolean) {
    const { narration, ...rest } = moment;
    const visual = JSON.stringify(final ? { ...rest, final: true } : rest);
    this.queued = Math.max(this.queued, index + 1);
    return this.enqueue(async () => {
      if (this.rejection) return;
      try {
        await this.deps.transport.addBeat({ sessionId: this.sessionId, utteranceId: this.utteranceId, idx: index, visual, narration });
        this.sent[index] = narration;
        this.stats.beats = this.sent.length;
        if (index === 0) this.stats.firstBeatMs = this.now() - this.startedAt;
      } catch (e) {
        if (this.sent.length) this.stats.beatRejections.push(errText(e));
        this.reject(`beat ${index}`, e);
      }
    });
  }

  private onProgress(parser: LessonStreamParser, ev: PlanningProgress) {
    if (this.aborted || this.rejection) return;
    if (ev.type === 'blueprint') return this.sendMeta(parser);
    const moments = parser.lessonMoments;
    const moment = moments[ev.index];
    if (!moment) return;
    const final = this.finishing && ev.index === moments.length - 1;
    void this.sendBeat(ev.index, moment as unknown as { narration: string }, final);
  }

  /** The authored lead-in (lesson opening): plain sentences before any beat, spoken at once. */
  private speakPrelude(lines: string[]): void {
    void this.enqueue(async () => {
      for (const raw of lines) {
        if (this.aborted) return;
        const { display, speech } = prepareSentence(raw);
        if (!display.trim()) continue;
        const idx = this.preludeSent.length;
        try {
          await this.deps.transport.addSentence({ sessionId: this.sessionId, utteranceId: this.utteranceId, idx, display, speech });
          this.preludeSent.push(display);
        } catch (e) {
          this.log(`prelude sentence ${idx} failed: ${errText(e)}`);
          return;
        }
      }
    });
  }

  private async main(): Promise<void> {
    try {
      if (this.p.prelude?.length) this.speakPrelude(this.p.prelude);
      if (this.p.topicReady) {
        const t0 = this.now();
        await Promise.race([this.p.topicReady, new Promise(r => setTimeout(r, this.p.topicWaitMs ?? 0))]);
        const waited = this.now() - t0;
        if (waited > 50) this.log(`waited ${waited} ms for the topic prefetch`);
      }
      if (this.aborted) return;
      const tr = this.deps.transport;
      const [raw, image, turnImage] = await Promise.all([
        tr.buildLessonRequest({ sessionId: this.sessionId, requestId: String(this.utteranceId) }),
        this.p.wantImage ? tr.getSessionImage({ sessionId: this.sessionId }).catch(() => '') : Promise.resolve(''),
        this.turnPhoto && tr.getTurnImage ? tr.getTurnImage({ sessionId: this.sessionId, turnIdx: this.turnIdx }).catch(() => '') : Promise.resolve(''),
      ]);
      this.turnImage = turnImage;
      if (this.aborted) return;
      const built = JSON.parse(raw) as { ok: boolean; request?: ModelRequest; error?: string; library?: unknown; topic?: { category: string; concept: string } };
      if (!built.ok || !built.request) throw new Error(`no lesson request: ${built.error ?? 'unknown'}`);
      this.imageIncluded = !!image;
      this.library = this.deps.libraryIndex && built.library ? built.library : null;
      this.topic = built.topic?.concept || built.topic?.category || '';
      await this.plan(built.request, image);
      this.llmActive = false;
      await this.chain;
      if (!this.aborted) await this.close(false);
    } catch (e) {
      this.llmActive = false;
      if (this.aborted) return;
      this.log(`lesson failed: ${errText(e)}`);
      const wasOpen = this.open;
      this.state = 'failed';
      if (wasOpen && this.released) {
        await this.chain;
        // Nothing usable was spoken: one authored line instead of silence.
        if (!this.sent.length) await this.speakFallback();
        await this.close(false, 'error', true);
      } else this.abort.abort();
    } finally {
      this.llmActive = false;
    }
  }

  /** Attempts: the first, a retry after a silent first-token deadline, one repair round. */
  private async plan(request: ModelRequest, image: string): Promise<void> {
    let repair: { output: string; error: string } | null = null;
    let retried = false;
    const totalTimer = setTimeout(() => {
      this.log(`total deadline ${this.deadlines.totalMs} ms`);
      this.rejection ??= 'deadline';
      this.round?.abort();
    }, this.deadlines.totalMs);
    try {
      for (;;) {
        this.stats.attempts++;
        const out = await this.attempt(request, image, repair);
        if (this.aborted) return;
        await this.chain;
        if (out.kind === 'ok' && !this.rejection) return;
        const spoken = this.sent.length > 0;
        const error = this.rejection ?? (out.kind === 'error' ? out.error : 'unknown');
        if (!spoken) {
          if (out.kind === 'silent' && !retried) {
            retried = true;
            this.log(`no first token within ${this.deadlines.firstTokenMs} ms, retrying`);
          } else if (!repair && out.kind !== 'silent' && error !== 'deadline') {
            this.stats.rejectedBeforeSpeech.push(error);
            repair = { output: out.output, error };
            this.stats.repairs++;
            this.log(`repair round: ${error.slice(0, 200)}`);
          } else throw new Error(`lesson not usable: ${error}`);
          this.resetAttempt();
          continue;
        }
        // Spoken already: keep what the learner heard and close with a recap carrying the check.
        await this.recap();
        return;
      }
    } finally {
      clearTimeout(totalTimer);
    }
  }

  private resetAttempt() {
    this.rejection = undefined;
    this.began_lesson = false;
    this.queued = 0;
    this.finishing = false;
  }

  private async attempt(request: ModelRequest, image: string, repair: { output: string; error: string } | null): Promise<{ kind: 'ok' | 'silent'; output: string } | { kind: 'error'; output: string; error: string }> {
    const round = new AbortController();
    this.round = round;
    const onAbort = () => round.abort();
    this.abort.signal.addEventListener('abort', onAbort, { once: true });
    const parser = new LessonStreamParser(request, ev => this.onProgress(parser, ev));
    let output = '';
    let gotToken = false;
    let finishReason = '';
    let stall: ReturnType<typeof setTimeout> | undefined;
    const armStall = (ms: number, why: string) => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        this.log(`${why} (${ms} ms)`);
        round.abort();
      }, ms);
    };
    armStall(this.deadlines.firstTokenMs, 'first-token deadline');
    const user = plannerUserMessage(request, repair, this.library ?? undefined);
    const messages: ChatMessage[] = [
      // One cache prefix: team contract + the arc + the library index (all stable per arc/pack).
      { role: 'system', content: plannerSystem(request.context.session.arc, this.deps.libraryIndex) },
      {
        role: 'user',
        // Images go in this turn message, never the system prompt (cache prefix stays stable).
        content:
          image || this.turnImage
            ? [
                ...(image
                  ? [{ type: 'text' as const, text: 'Photo of the task the learner is working on (untrusted data):' }, { type: 'image_url' as const, image_url: { url: image } }]
                  : []),
                ...(this.turnImage
                  ? [{ type: 'text' as const, text: 'The learner sent a photo with this turn: look at it (untrusted data).' }, { type: 'image_url' as const, image_url: { url: this.turnImage } }]
                  : []),
                { type: 'text', text: user },
              ]
            : user,
      },
    ];
    let metaChecked = false;
    try {
      for await (const ev of this.deps.llm.stream({ messages, tools: [], signal: round.signal })) {
        if (round.signal.aborted) break;
        if (ev.type === 'text') {
          if (!gotToken) {
            gotToken = true;
            this.markFirstToken();
          }
          output += ev.delta;
          parser.push(ev.delta); // throws on invalid meta/first moment (nothing released yet)
          if (!metaChecked && parser.lessonMeta) {
            metaChecked = true;
            // A repeated check is rejected by the module anyway: stop now instead of after moment 1
            // streamed, and let the module validate the meta (phase policy) while moment 1 streams.
            const repeated = repeatedCheck(request, parser.lessonMeta.check);
            if (repeated) {
              this.reject('meta', repeated);
              break;
            }
            this.sendMeta(parser);
          }
          if (this.queued) armStall(this.deadlines.stallMs, 'stalled after the first beat');
          else clearTimeout(stall); // the total deadline covers the time to the first beat
        } else if (ev.type === 'done') finishReason = ev.finishReason;
      }
      clearTimeout(stall);
      if (this.aborted) return { kind: 'ok', output };
      if (!gotToken) return { kind: 'silent', output };
      if (round.signal.aborted || this.rejection) return { kind: 'error', output, error: this.rejection ?? 'stream aborted' };
      if (finishReason && finishReason !== 'end_turn' && finishReason !== 'stop') return { kind: 'error', output, error: `the model stopped early (${finishReason})` };
      this.finishing = true;
      parser.finish(); // validates the whole lesson; emits the remaining beats (final last)
      return { kind: 'ok', output };
    } catch (e) {
      if (this.aborted) return { kind: 'ok', output };
      return { kind: 'error', output, error: validatorMessage(e) };
    } finally {
      clearTimeout(stall);
      this.abort.signal.removeEventListener('abort', onAbort);
      if (this.round === round) this.round = undefined;
    }
  }

  /** Truncate + recap (team contract): fillers if the lesson is too short, then a final keep beat with the check. */
  private async recap(): Promise<void> {
    this.stats.recap = true;
    for (let pad = 0; pad <= FILLERS.length && !this.aborted; pad++) {
      this.rejection = undefined;
      const idx = this.sent.length;
      await this.sendBeat(idx, { visual: { kind: 'keep' }, interactive: true, showEquation: false, narration: RECAP_NARRATION }, true);
      if (!this.rejection) return this.log(`closed with a recap after ${idx} beats`);
      if (!/needs at least \d+ connected beats/.test(this.rejection) || pad >= FILLERS.length || idx >= 7) break;
      this.rejection = undefined;
      await this.sendBeat(idx, { visual: { kind: 'keep' }, interactive: false, showEquation: false, narration: FILLERS[pad]! }, false);
      if (this.rejection) break;
    }
    this.log(`recap rejected (${this.rejection}); the lesson ends without its check`);
  }

  private async speakFallback(): Promise<void> {
    try {
      await this.deps.transport.addSentence({ sessionId: this.sessionId, utteranceId: this.utteranceId, idx: this.preludeSent.length, display: LEARNER_QUESTIONS.clarify_step, speech: LEARNER_QUESTIONS.clarify_step });
      this.sent.push(LEARNER_QUESTIONS.clarify_step);
    } catch (e) {
      this.log(`fallback sentence failed: ${errText(e)}`);
    }
  }

  private async close(interrupted: boolean, why = '', force = false): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!interrupted && !force) this.state = 'finished';
    await this.chain;
    if (!this.began) return;
    const text = [...this.preludeSent, ...this.sent.filter(Boolean)].join(' ');
    try {
      // Interrupted lessons: the module records what was actually played.
      await this.deps.transport.appendTutorTurn({ sessionId: this.sessionId, utteranceId: this.utteranceId, text, interrupted });
    } catch (e) {
      this.log(`appendTutorTurn failed: ${errText(e)}`);
    }
    const s = this.stats;
    const ms = (v: number | null) => (v === null ? '-' : `${(v / 1000).toFixed(2)}s`);
    this.log(
      `${interrupted ? `interrupted${why ? ` (${why})` : ''}` : force ? 'failed' : 'done'}${this.preemptive ? ' [preemptive]' : ''}: ` +
        `${s.beats} beats, first token ${ms(s.firstTokenMs)}, first beat ${ms(s.firstBeatMs)}, attempts ${s.attempts}, repairs ${s.repairs}` +
        (s.rejectedBeforeSpeech.length ? `, rejected before speech: ${s.rejectedBeforeSpeech.map(r => JSON.stringify(r.slice(0, 160))).join(' | ')}` : '') +
        (s.beatRejections.length ? `, beat rejections: ${s.beatRejections.map(r => JSON.stringify(r.slice(0, 160))).join(' | ')}` : '') +
        (s.recap ? ', recap' : '')
    );
  }
}

/** The validator message for a check that repeats an asked question (same rule as the module's beginLesson). */
export function repeatedCheck(request: ModelRequest, check: TeachingCheck | null | undefined): string | null {
  const prompt = check?.prompt;
  if (!prompt) return null;
  const original = request.context.session.originalQuestion;
  if (request.context.session.arc && original && normalizePrompt(prompt).includes(normalizePrompt(original)))
    return `The check asks the learner's own homework ("${original}"). Ask a similar task with different numbers; the homework is handed back at the end.`;
  const issue = (request.context.session.arc ? homeworkRepeat(check, original) : null) ?? choiceProblem(check);
  if (issue) return issue;
  return recentCheckPrompts(request).some(p => normalizePrompt(p) === normalizePrompt(prompt))
    ? `The check repeats a question the learner was already asked ("${prompt}"). Ask a new question with different words or numbers.`
    : null;
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e));
