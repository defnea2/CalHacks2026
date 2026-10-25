// LlmProvider for OpenRouter (OpenAI-compatible) via the `openai` SDK. Streams text deltas and
// assembled tool calls; aborts via the AbortSignal. First check #5: reasoning effort `none`
// gives the fastest first token for openai/gpt-5.6-luna.
import OpenAI from 'openai';
import type { ChatMessage, ChatToolCall, LlmEvent, LlmProvider, ToolSpec } from '@tutor/shared';

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  /** OpenRouter `reasoning.effort`; '' leaves the model default. */
  reasoningEffort?: string;
  baseURL?: string;
  /** Extra body fields merged into every request. */
  extraBody?: Record<string, unknown>;
}

type OAMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function toOpenAiMessages(messages: ChatMessage[]): OAMessage[] {
  return messages.map((m): OAMessage => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? p.text : '')).join('\n') };
      case 'user':
        return { role: 'user', content: m.content as OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'] };
      case 'assistant': {
        const text = typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? p.text : '')).join('');
        const out: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = { role: 'assistant', content: text || null };
        if (m.toolCalls?.length) {
          out.tool_calls = m.toolCalls.map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments || '{}' } }));
        }
        return out;
      }
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
    }
  });
}

const isAbort = (e: unknown, signal: AbortSignal) =>
  signal.aborted || (e instanceof Error && (e.name === 'AbortError' || e.name === 'APIUserAbortError'));

export class OpenRouterProvider implements LlmProvider {
  private readonly client: OpenAI;

  constructor(private readonly opts: OpenRouterOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL ?? 'https://openrouter.ai/api/v1', maxRetries: 1 });
  }

  async *stream(o: { messages: ChatMessage[]; tools: ToolSpec[]; signal: AbortSignal }): AsyncIterable<LlmEvent> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      stream: true,
      messages: toOpenAiMessages(o.messages),
      ...(o.tools.length
        ? { tools: o.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), parallel_tool_calls: true }
        : {}),
      ...(this.opts.reasoningEffort ? { reasoning: { effort: this.opts.reasoningEffort } } : {}),
      ...this.opts.extraBody,
    };
    // Tool-call deltas arrive per index; a call is complete when a later index starts or the stream ends.
    const pending = new Map<number, ChatToolCall>();
    let finishReason = 'stop';
    const emitUpTo = function* (maxIndex: number): Generator<LlmEvent> {
      for (const idx of [...pending.keys()].sort((a, b) => a - b)) {
        if (idx > maxIndex) break;
        const call = pending.get(idx)!;
        pending.delete(idx);
        yield { type: 'tool_call', call };
      }
    };
    try {
      const stream = (await this.client.chat.completions.create(
        body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        { signal: o.signal }
      )) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
      let seq = 0;
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const d = choice.delta;
        if (d?.content) yield { type: 'text', delta: d.content };
        for (const tc of d?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          if (!pending.has(idx)) {
            yield* emitUpTo(idx - 1);
            pending.set(idx, { id: tc.id || `call_${Date.now()}_${seq++}`, name: '', arguments: '' });
          }
          const call = pending.get(idx)!;
          if (tc.function?.name) call.name += tc.function.name;
          if (tc.function?.arguments) call.arguments += tc.function.arguments;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      yield* emitUpTo(Number.MAX_SAFE_INTEGER);
      yield { type: 'done', finishReason };
    } catch (e) {
      if (isAbort(e, o.signal)) return;
      throw e;
    }
  }
}
