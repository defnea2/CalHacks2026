// Test doubles: a recording Transport and a scripted LlmProvider.
import { pack, type ChatMessage, type LlmEvent, type LlmProvider, type ToolSpec } from '@tutor/shared';
import { Agent, type AgentOptions } from '../src/agent';
import type { PhraseRow, SessionRow, Transport, TurnRow } from '../src/transport';

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

export interface Call {
  name: keyof Transport;
  args: Record<string, unknown>;
}

/** Records every call; methods can be made to fail or wait. */
export class FakeTransport implements Transport {
  readonly calls: Call[] = [];
  fail: Partial<Record<keyof Transport, string>> = {};
  delayMs: Partial<Record<keyof Transport, number>> = {};
  context = 'Learner: Test Kid. Current phase: start.';
  image = '';
  topicResult = JSON.stringify({ ok: true, material: { concepts: ['c1'] }, notes: [] });

  private async rec(name: keyof Transport, args: object): Promise<void> {
    this.calls.push({ name, args: args as Record<string, unknown> });
    const d = this.delayMs[name];
    if (d) await sleep(d);
    const f = this.fail[name];
    if (f) throw new Error(f);
  }

  of(name: keyof Transport, sessionId?: bigint): Record<string, unknown>[] {
    return this.calls.filter(c => c.name === name && (sessionId === undefined || c.args.sessionId === sessionId)).map(c => c.args);
  }
  names(sessionId?: bigint): string[] {
    return this.calls.filter(c => sessionId === undefined || c.args.sessionId === sessionId).map(c => c.name).filter(n => n !== 'recordMetric');
  }

  beginUtterance = (a: object) => this.rec('beginUtterance', a);
  beginOpening = (a: object) => this.rec('beginOpening', a);
  addSentence = (a: object) => this.rec('addSentence', a);
  appendTutorTurn = (a: object) => this.rec('appendTutorTurn', a);
  recordMetric = (a: object) => this.rec('recordMetric', a);
  setPhase = (a: object) => this.rec('setPhase', a);
  showBoardItem = (a: object) => this.rec('showBoardItem', a);
  clearBoard = (a: object) => this.rec('clearBoard', a);
  remember = (a: object) => this.rec('remember', a);
  buildContext = async (a: object) => (await this.rec('buildContext', a), this.context);
  setTopic = async (a: object) => (await this.rec('setTopic', a), this.topicResult);
  getSessionImage = async (a: object) => (await this.rec('getSessionImage', a), this.image);
}

export type Step = LlmEvent | { type: 'wait'; ms?: number; until?: Promise<unknown> };
/** Per LLM call: the steps to stream. Calls beyond the list say one plain sentence. */
export type Script = Step[][] | ((call: number, messages: ChatMessage[]) => Step[]);

export const text = (delta: string): LlmEvent => ({ type: 'text', delta });
export const tool = (name: string, args: unknown, id = `c_${name}_${Math.random().toString(36).slice(2, 7)}`): LlmEvent => ({
  type: 'tool_call',
  call: { id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});
export const done: LlmEvent = { type: 'done', finishReason: 'stop' };

/** Splits a text into token-ish deltas. */
export const tokens = (s: string): LlmEvent[] => (s.match(/\S+\s*/g) ?? []).map(text);

export class FakeLlm implements LlmProvider {
  readonly calls: { messages: ChatMessage[]; tools: ToolSpec[]; signal: AbortSignal }[] = [];

  constructor(private readonly script: Script) {}

  async *stream(o: { messages: ChatMessage[]; tools: ToolSpec[]; signal: AbortSignal }): AsyncIterable<LlmEvent> {
    const i = this.calls.length;
    this.calls.push({ messages: [...o.messages], tools: o.tools, signal: o.signal });
    const steps: Step[] =
      typeof this.script === 'function' ? this.script(i, o.messages) : (this.script[i] ?? [...tokens('Okay, let us keep going with this one.'), done]);
    const aborted = new Promise<void>(r => o.signal.addEventListener('abort', () => r(), { once: true }));
    for (const s of steps) {
      if (o.signal.aborted) return;
      if (s.type === 'wait') {
        await Promise.race([s.until ?? sleep(s.ms ?? 0), aborted]);
        continue;
      }
      yield s;
      await sleep(0);
    }
  }
}

export const OPTS: AgentOptions = { preemptive: false, preemptiveSilenceMs: 30, maxToolRounds: 2, recentTurns: 12, toolTimeoutMs: 200, verifiedSpeech: false };

export function makeAgent(llm: LlmProvider, transport = new FakeTransport(), opts: Partial<AgentOptions> = {}, logs: string[] = []) {
  const agent = new Agent({ transport, llm, pack, opts: { ...OPTS, ...opts }, log: m => logs.push(m) });
  return { agent, transport, logs };
}

export function session(id: bigint, over: Partial<SessionRow> = {}): SessionRow {
  return { id, taskText: 'Expand 2/3 to twelfths', phase: pack.initialPhase, turnState: 'listening', active: true, hasImage: false, currentUtteranceId: 0n, turnCount: 0, ...over };
}

export function turn(sessionId: bigint, idx: number, textValue: string, status = 'ready', role = 'student'): TurnRow {
  return { sessionId, idx, role, text: textValue, status, utteranceId: 0n, interrupted: false };
}

export function phrase(sessionId: bigint, phraseId: number, turnIdx: number, status: string, textValue = ''): PhraseRow {
  return { sessionId, phraseId, turnIdx, status, text: textValue };
}

/** The last user message (the current turn; the phase block system message follows it). */
export const lastUser = (msgs: ChatMessage[]) => [...msgs].reverse().find(m => m.role === 'user');
