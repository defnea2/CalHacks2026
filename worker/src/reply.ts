// ReplyRun: one tutor reply to one student turn (LiveKit's "speech handle").
//
// The LLM loop streams text and tool calls. Everything it produces goes through an ordered
// outbox: sentences (addSentence) and tool calls (ToolRouter) are applied strictly in the order
// received, so a board item is tagged with the index of the sentence that follows it.
//
// The outbox sits behind a gate. A live run opens the gate at once. A preemptive run starts
// while the student may still continue: its output is held in memory until release() (turn
// became ready with the same transcript) or thrown away by discard(). Nothing reaches
// SpacetimeDB before release(), not even beginUtterance.
//
// Inline board markers: the model writes ⟦b1⟧ where an item should appear and calls the board
// tool with id "b1" after its text. Sentences go out without markers; `anchors` remembers each
// marker's sentence + speech offset, and the tool stores that as the item's reveal anchor. A
// tool call whose marker is still in the chunker buffer waits until the round's text is cut
// (and every later call of the round with it, to keep their order).
import { SentenceChunker, prepareSentence, type ChatMessage, type LlmProvider, type MetricName } from '@tutor/shared';
import { MarkerAnchors } from './markers';
import { buildMessages } from './prompt';
import type { ToolResult, ToolRouter } from './router';
import type { Transport, TurnRow } from './transport';

/** Delays before retrying an LLM round that failed before any output (unstable connections). */
const LLM_RETRY_DELAYS_MS = [400, 1200];

export interface ReplyDeps {
  transport: Transport;
  llm: LlmProvider;
  router: ToolRouter;
  system: string;
  maxToolRounds: number;
  recentTurns: number;
  log: (msg: string) => void;
  /** Sentence status lookup (from the subscription) to tell what was actually played. */
  isDropped?: (utteranceId: bigint, idx: number) => boolean;
  now?: () => number;
}

export interface ReplyParams {
  sessionId: bigint;
  turnIdx: number;
  /** Student transcript this reply answers. */
  transcript: string;
  utteranceId: bigint;
  /** Earlier turns of the session (read when the prompt is built). */
  turns: () => TurnRow[];
  wantImage: boolean;
  /** Preemptive: hold all output until release(). */
  held: boolean;
}

export type ReplyState = 'held' | 'live' | 'finished' | 'interrupted' | 'discarded' | 'failed';

export class ReplyRun {
  readonly sessionId: bigint;
  readonly turnIdx: number;
  readonly transcript: string;
  readonly utteranceId: bigint;
  state: ReplyState;
  /** True while the LLM loop runs (streaming or waiting for tool results). */
  llmActive = true;
  /** Display texts of the sentences added so far. */
  readonly sent: string[] = [];
  /** Tool results in the order applied. */
  readonly toolResults: ToolResult[] = [];
  /** Messages sent to the LLM in the last round (chat history of this reply). */
  history: ChatMessage[] = [];
  imageIncluded = false;
  preemptive = false;
  /** Settles when the run is fully over (LLM done, outbox drained, tutor turn appended). */
  readonly done: Promise<void>;

  private readonly abort = new AbortController();
  private readonly anchors = new MarkerAnchors();
  private releaseGate!: () => void;
  private readonly gate = new Promise<void>(r => (this.releaseGate = r));
  private chain: Promise<unknown>;
  private released = false;
  private began = false;
  private closed = false;
  private firstTokenAt = 0;
  private firstTokenRecorded = false;
  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(
    private readonly deps: ReplyDeps,
    private readonly p: ReplyParams
  ) {
    this.sessionId = p.sessionId;
    this.turnIdx = p.turnIdx;
    this.transcript = p.transcript;
    this.utteranceId = p.utteranceId;
    this.state = p.held ? 'held' : 'live';
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
    this.chain = this.gate.then(() => this.begin());
    this.done = this.main();
    if (!p.held) this.release(false);
  }

  get aborted(): boolean {
    return this.abort.signal.aborted;
  }

  /** Still producing or about to produce output (not closed, not thrown away). */
  get open(): boolean {
    return this.state === 'held' || this.state === 'live';
  }

  /** Lets held output through: beginUtterance, then everything queued so far, in order. */
  release(preemptive: boolean): void {
    if (this.released || this.aborted) return;
    this.released = true;
    this.preemptive = preemptive;
    this.state = 'live';
    this.releaseGate();
  }

  /** Throws away a run whose output never reached SpacetimeDB (preemptive, student spoke again). */
  discard(why = ''): void {
    if (this.released) return this.interrupt(why);
    if (!this.open) return;
    this.state = 'discarded';
    this.abort.abort();
    this.releaseGate(); // let queued ops drain as no-ops
    this.log(`discarded preemptive reply${why ? ` (${why})` : ''}`);
  }

  /** Barge-in or a newer turn: stop the LLM, add no more sentences, record what was said. */
  interrupt(why = ''): void {
    if (!this.released) return this.discard(why);
    if (!this.open) return;
    this.state = 'interrupted';
    this.abort.abort();
    void this.close(true, why);
  }

  // ------------------------------------------------------------------ internals

  private log(msg: string) {
    this.deps.log(`[s${this.sessionId} t${this.turnIdx} u${this.utteranceId}] ${msg}`);
  }

  private metric(name: MetricName, atMs: number) {
    this.deps.transport
      .recordMetric({ sessionId: this.sessionId, turnIdx: this.turnIdx, name, atMicros: BigInt(Math.round(atMs)) * 1000n })
      .catch(e => this.log(`recordMetric ${name} failed: ${errText(e)}`));
  }

  private markFirstToken() {
    if (this.firstTokenAt) return;
    this.firstTokenAt = this.now();
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
      await this.deps.transport.beginUtterance({
        sessionId: this.sessionId,
        utteranceId: this.utteranceId,
        replyToIdx: this.turnIdx,
        preemptive: this.preemptive,
      });
      this.began = true;
      this.recordFirstToken();
    } catch (e) {
      this.log(`beginUtterance failed: ${errText(e)}`);
      this.state = 'failed';
      this.abort.abort();
    }
  }

  /** Appends an op to the ordered outbox. Ops after an abort are skipped. */
  private enqueue<T>(op: () => Promise<T>, skipped: T): Promise<T> {
    const p = this.chain.then(() => (this.aborted ? skipped : op()));
    this.chain = p.catch(() => undefined);
    return p;
  }

  private enqueueSentence(raw: string): void {
    this.anchors.noteText(raw);
    void this.enqueue(async () => {
      const { display, speech, markers } = prepareSentence(raw);
      if (!display.trim()) {
        this.anchors.addMarkerOnly(markers);
        return;
      }
      const idx = this.sent.length;
      this.sent.push(display);
      this.anchors.addSentence(idx, speech.length, markers);
      if (idx === 0) this.metric('firstSentenceAt', this.now());
      try {
        await this.deps.transport.addSentence({
          sessionId: this.sessionId,
          utteranceId: this.utteranceId,
          idx,
          display,
          speech,
        });
      } catch (e) {
        this.log(`addSentence ${idx} failed: ${errText(e)}`);
      }
    }, undefined);
  }

  private enqueueTool(call: ToolResult['call']): Promise<ToolResult> {
    const skipped: ToolResult = { call, kind: this.deps.router.kindOf(call.name), ok: false, result: 'error: reply was interrupted' };
    return this.enqueue(async () => {
      const r = await this.deps.router.run(call, {
        sessionId: this.sessionId,
        utteranceId: this.utteranceId,
        nextSentenceIdx: this.sent.length,
        anchor: id => this.anchors.take(id),
        transport: this.deps.transport,
      });
      this.toolResults.push(r);
      return r;
    }, skipped);
  }

  private async main(): Promise<void> {
    try {
      const [context, image] = await Promise.all([
        this.deps.transport.buildContext({ sessionId: this.sessionId }),
        this.p.wantImage ? this.deps.transport.getSessionImage({ sessionId: this.sessionId }).catch(() => '') : Promise.resolve(''),
      ]);
      if (this.aborted) return;
      this.imageIncluded = !!image;
      this.history = buildMessages({
        system: this.deps.system,
        context,
        turns: this.p.turns(),
        current: { idx: this.turnIdx, text: this.transcript },
        recentTurns: this.deps.recentTurns,
        image,
      });
      let spoken = false;
      for (let round = 0; ; round++) {
        const chunker = new SentenceChunker();
        let text = '';
        let raw: unknown;
        const calls: ToolResult['call'][] = [];
        const results: Promise<ToolResult>[] = [];
        const waiting: ToolResult['call'][] = [];
        // Last allowed round: offer no tools, so the model has to speak (it otherwise tends to
        // chain tool-only rounds and the student hears nothing).
        const last = round >= this.deps.maxToolRounds && round > 0;
        const tools = last ? [] : this.deps.router.specs();
        // A round that fails before any event arrived is retried (flaky network): nothing from it
        // reached SpacetimeDB yet. Once output has started, a failure ends the reply as before.
        for (let attempt = 0; ; attempt++) {
          let gotEvent = false;
          try {
            const stream = this.deps.llm.stream({ messages: this.history, tools, signal: this.abort.signal });
            for await (const ev of stream) {
              gotEvent = true;
              if (this.aborted) break;
              if (ev.type === 'text') {
                this.markFirstToken();
                text += ev.delta;
                for (const s of chunker.push(ev.delta)) this.enqueueSentence(s);
              } else if (ev.type === 'tool_call') {
                this.markFirstToken();
                // A finished sentence before the call belongs before it (board reveal index).
                for (const s of chunker.flushComplete()) this.enqueueSentence(s);
                calls.push(ev.call);
                if (waiting.length || this.anchors.waitsFor(ev.call.arguments)) waiting.push(ev.call);
                else results.push(this.enqueueTool(ev.call));
              } else if (ev.type === 'done') {
                raw = ev.raw;
              }
            }
            break;
          } catch (e) {
            if (gotEvent || this.aborted || attempt >= LLM_RETRY_DELAYS_MS.length) throw e;
            this.log(`llm round ${round} failed before output (${errText(e)}), retry ${attempt + 1}`);
            await new Promise(r => setTimeout(r, LLM_RETRY_DELAYS_MS[attempt]));
            if (this.aborted) return;
          }
        }
        if (this.aborted) return;
        for (const s of chunker.flush()) this.enqueueSentence(s);
        for (const c of waiting) results.push(this.enqueueTool(c));
        const res = await Promise.all(results);
        if (this.aborted) return;
        if (text.trim()) spoken = true;
        this.history = [
          ...this.history,
          { role: 'assistant', content: text, ...(calls.length ? { toolCalls: calls } : {}), ...(raw !== undefined ? { raw } : {}) },
          ...res.map((r): ChatMessage => ({ role: 'tool', toolCallId: r.call.id, name: r.call.name, content: r.result })),
        ];
        if (!calls.length) break;
        // Query results must go back to the LLM; action results only if nothing was said yet.
        const again = res.some(r => r.kind === 'query') || !spoken;
        if (!again) break;
        if (round >= this.deps.maxToolRounds) {
          this.log(`max tool rounds (${this.deps.maxToolRounds}) reached`);
          break;
        }
      }
      this.llmActive = false;
      await this.chain;
      if (!this.aborted) await this.close(false);
    } catch (e) {
      this.llmActive = false;
      if (this.aborted) return;
      this.log(`reply failed: ${errText(e)}`);
      // Keep whatever was already said; the turn still needs closing.
      const wasOpen = this.open;
      this.state = 'failed';
      if (wasOpen && this.released) await this.close(false, 'error', true);
      else this.abort.abort();
    } finally {
      this.llmActive = false;
    }
  }

  private async close(interrupted: boolean, why = '', force = false): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!interrupted && !force) this.state = 'finished';
    await this.chain; // in-flight ops settle; later ones are skipped after an abort
    if (!this.began) return;
    let said = this.sent;
    if (interrupted && this.deps.isDropped) {
      // The interrupt reducer marks unplayed sentences dropped; let that update arrive first.
      await new Promise(r => setTimeout(r, 0));
      said = this.sent.filter((_, i) => !this.deps.isDropped!(this.utteranceId, i));
    }
    const text = said.join(' ');
    try {
      await this.deps.transport.appendTutorTurn({ sessionId: this.sessionId, utteranceId: this.utteranceId, text, interrupted });
    } catch (e) {
      this.log(`appendTutorTurn failed: ${errText(e)}`);
    }
    const tools = this.toolResults.map(r => `${r.call.name} ${r.ok ? 'ok' : r.result}`).join(', ');
    const ft = this.firstTokenAt ? `${((this.firstTokenAt - this.startedAt) / 1000).toFixed(2)}s` : '-';
    this.log(
      `${interrupted ? `interrupted${why ? ` (${why})` : ''}` : 'done'}${this.preemptive ? ' [preemptive]' : ''}: ` +
        `${said.length}/${this.sent.length} sentences, first token ${ft}${tools ? `, tools: ${tools}` : ''}`
    );
  }
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e));
