// Mapping from the neutral ChatMessage list to the Anthropic Messages API request.
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@tutor/shared';
import { toAnthropicRequest, toAnthropicTools } from '../src/anthropic';

describe('toAnthropicRequest', () => {
  it('puts leading system messages into system blocks, caching the first (stable) one', () => {
    const { system, messages } = toAnthropicRequest([
      { role: 'system', content: 'PACK PROMPT' },
      { role: 'system', content: 'CONTEXT' },
      { role: 'user', content: 'hi' },
    ]);
    expect(system).toEqual([
      { type: 'text', text: 'PACK PROMPT', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'CONTEXT' },
    ]);
    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('keeps later system messages as mid-conversation system messages (append-only)', () => {
    const { messages } = toAnthropicRequest([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' },
      { role: 'system', content: 'Phase is now intuition.' },
    ]);
    expect(messages).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'system', content: 'Phase is now intuition.' },
    ]);
  });

  it('replays raw assistant content unchanged and groups tool results into one user message', () => {
    const raw = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'Let us look.' },
      { type: 'tool_use', id: 't1', name: 'set_phase', input: { phase: 'x', reason: 'y' } },
      { type: 'tool_use', id: 't2', name: 'clear_board', input: {} },
    ];
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'Let us look.', toolCalls: [{ id: 't1', name: 'set_phase', arguments: '{}' }], raw },
      { role: 'tool', toolCallId: 't1', name: 'set_phase', content: 'ok' },
      { role: 'tool', toolCallId: 't2', name: 'clear_board', content: 'error: nothing to clear' },
    ];
    const { messages } = toAnthropicRequest(msgs);
    expect(messages[1]).toEqual({ role: 'assistant', content: raw });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
        { type: 'tool_result', tool_use_id: 't2', content: 'error: nothing to clear', is_error: true },
      ],
    });
  });

  it('rebuilds assistant turns without raw from text + tool calls, and skips empty ones', () => {
    const { messages } = toAnthropicRequest([
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'Hi.' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'remember', arguments: '{"kind":"quote"}' }] },
    ]);
    expect(messages).toEqual([
      { role: 'user', content: 'u' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'remember', input: { kind: 'quote' } }] },
    ]);
  });

  it('maps data-URL images to base64 image blocks', () => {
    const { messages } = toAnthropicRequest([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Photo:' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
        ],
      },
    ]);
    expect(messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Photo:' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      ],
    });
  });

  it('opens with a user turn when there is none yet (tutor speaks first)', () => {
    const { messages } = toAnthropicRequest([{ role: 'system', content: 'S' }]);
    expect(messages).toEqual([{ role: 'user', content: '[The session starts.]' }]);
  });
});

describe('toAnthropicTools', () => {
  it('passes schemas through and enables eager input streaming', () => {
    expect(toAnthropicTools([{ name: 'clear_board', description: 'd', parameters: { type: 'object', properties: {} } }])).toEqual([
      { name: 'clear_board', description: 'd', input_schema: { type: 'object', properties: {} }, eager_input_streaming: true },
    ]);
  });
});
