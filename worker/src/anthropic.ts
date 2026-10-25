// LlmProvider for Claude via the Anthropic Messages API (`@anthropic-ai/sdk`), default model
// claude-haiku-5-5. Streams text deltas and completed tool calls; aborts via the AbortSignal.
//
// Mapping from the provider-neutral ChatMessage list:
// - Leading system messages -> top-level `system` blocks. The first one (the stable pack
//   prompt) carries the cache breakpoint; the per-turn context follows it uncached.
// - Later system messages -> mid-conversation `role: "system"` messages (append-only, so the
//   cached prefix and replayed thinking blocks stay valid, e.g. on a phase change mid-reply).
// - Assistant messages with `raw` (this provider's own content blocks, thinking included) are
//   sent back unchanged; others are rebuilt from text + tool calls.
// - Consecutive tool results -> one user message of `tool_result` blocks.
import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, LlmEvent, LlmProvider, ToolSpec } from '@tutor/shared';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** `output_config.effort`: low | medium | high | xhigh | max. */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** `adaptive` (default) or `disabled` (allowed on Haiku 5.5 at effort high or below). */
  thinking: 'adaptive' | 'disabled';
  maxTokens?: number;
  baseURL?: string;
}

const textOf = (c: ChatMessage['content']) => (typeof c === 'string' ? c : c.map(p => (p.type === 'text' ? p.text : '')).join('\n'));

function userContent(c: ChatMessage['content']): Anthropic.MessageParam['content'] {
  if (typeof c === 'string') return c;
  return c.map((p): Anthropic.ContentBlockParam => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    const m = p.image_url.url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/);
    if (m) return { type: 'image', source: { type: 'base64', media_type: m[1] as 'image/png', data: m[2]! } };
    return { type: 'image', source: { type: 'url', url: p.image_url.url } };
  });
}

function parseArgs(json: string): unknown {
  try {
    return json.trim() ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}

/** Converts the neutral message list into Anthropic `system` + `messages`. */
export function toAnthropicRequest(messages: ChatMessage[]): { system: Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[] } {
  const system: Anthropic.TextBlockParam[] = [];
  const out: Anthropic.MessageParam[] = [];
  let i = 0;
  for (; i < messages.length && messages[i]!.role === 'system'; i++) {
    const text = textOf(messages[i]!.content);
    if (text.trim()) system.push({ type: 'text', text });
  }
  if (system.length) system[0] = { ...system[0]!, cache_control: { type: 'ephemeral' } };

  let pendingResults: Anthropic.ToolResultBlockParam[] = [];
  const flushResults = () => {
    if (pendingResults.length) out.push({ role: 'user', content: pendingResults });
    pendingResults = [];
  };
  for (; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'tool') {
      const content = textOf(m.content);
      pendingResults.push({ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content, ...(/^error\b/i.test(content) ? { is_error: true } : {}) });
      continue;
    }
    flushResults();
    if (m.role === 'system') {
      const text = textOf(m.content);
      // A mid-conversation system message must follow a user turn; earlier ones fold into `system`.
      if (out.length) out.push({ role: 'system', content: text });
      else if (text.trim()) system.push({ type: 'text', text });
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: userContent(m.content) });
    } else {
      const raw = m.raw as Anthropic.ContentBlockParam[] | undefined;
      if (Array.isArray(raw) && raw.length) {
        out.push({ role: 'assistant', content: raw });
        continue;
      }
      const blocks: Anthropic.ContentBlockParam[] = [];
      const text = textOf(m.content);
      if (text.trim()) blocks.push({ type: 'text', text });
      for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: parseArgs(c.arguments) as Record<string, unknown> });
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    }
  }
  flushResults();
  // The conversation must open with a user turn (e.g. the tutor's opening reply has none yet).
  if (!out.length || out[0]!.role !== 'user') out.unshift({ role: 'user', content: '[The session starts.]' });
  return { system, messages: out };
}

export function toAnthropicTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
    // Inputs stream as generated; the ToolRouter validates them against the schema before running.
    eager_input_streaming: true,
  }));
}

const isAbort = (e: unknown, signal: AbortSignal) => signal.aborted || e instanceof Anthropic.APIUserAbortError;

export class AnthropicProvider implements LlmProvider {
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicOptions) {
    // maxRetries 1: the reply loop already retries a round that fails before any output.
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 1 });
  }

  async *stream(o: { messages: ChatMessage[]; tools: ToolSpec[]; signal: AbortSignal }): AsyncIterable<LlmEvent> {
    const { system, messages } = toAnthropicRequest(o.messages);
    // Tool-use blocks by stream index: id/name at start, input JSON accumulated from deltas.
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    try {
      const stream = this.client.messages.stream(
        {
          model: this.opts.model,
          max_tokens: this.opts.maxTokens ?? 8000,
          system,
          messages,
          ...(o.tools.length ? { tools: toAnthropicTools(o.tools) } : {}),
          thinking: { type: this.opts.thinking },
          output_config: { effort: this.opts.effort },
        },
        { signal: o.signal }
      );
      for await (const ev of stream) {
        if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
          toolBlocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: '' });
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') yield { type: 'text', delta: ev.delta.text };
          else if (ev.delta.type === 'input_json_delta') {
            const b = toolBlocks.get(ev.index);
            if (b) b.json += ev.delta.partial_json;
          }
        } else if (ev.type === 'content_block_stop') {
          const b = toolBlocks.get(ev.index);
          if (b) {
            toolBlocks.delete(ev.index);
            yield { type: 'tool_call', call: { id: b.id, name: b.name, arguments: b.json || '{}' } };
          }
        }
      }
      const final = await stream.finalMessage();
      // A refusal can cut a tool_use off mid-input: those never reached content_block_stop above.
      yield { type: 'done', finishReason: final.stop_reason ?? 'end_turn', raw: final.content };
    } catch (e) {
      if (isAbort(e, o.signal)) return;
      throw e;
    }
  }
}
