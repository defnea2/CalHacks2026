// Smoke test of the OpenRouter provider with the real system prompt and tools (no SpacetimeDB).
// `pnpm --filter worker smoke:llm`. Prints events and timings, never keys.
import { pack, SentenceChunker, normalizeForSpeech, type ChatMessage } from '@tutor/shared';
import { loadConfig } from './env';
import { createLlm } from './providers';
import { buildSystemPrompt } from './prompt';
import { createToolDefs } from './tools/index';

const cfg = loadConfig();
const tools = createToolDefs(pack).map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
const { llm, info } = createLlm(cfg);
const messages: ChatMessage[] = [
  { role: 'system', content: buildSystemPrompt(pack, tools) },
  { role: 'system', content: `Learner: Mia, 10, grade 5, likes pictures.\nOriginal task: Expand 2/3 so the bottom number is 12.\nCurrent phase: ${pack.initialPhase}\nBoard right now: empty` },
  { role: 'user', content: process.argv[2] ?? "I don't get how 2/3 can be the same as 8/12. It has bigger numbers!" },
];

const ctrl = new AbortController();
for (let round = 0; round < 3; round++) {
  const t0 = Date.now();
  let first = 0;
  let text = '';
  const calls: { id: string; name: string; arguments: string }[] = [];
  const chunker = new SentenceChunker();
  for await (const ev of llm.stream({ messages, tools: round === 2 ? [] : tools, signal: ctrl.signal })) {
    if (!first && ev.type !== 'done') first = Date.now() - t0;
    if (ev.type === 'text') {
      text += ev.delta;
      for (const s of chunker.push(ev.delta)) console.log(`${Date.now() - t0}ms sentence: ${s}\n        speech: ${normalizeForSpeech(s)}`);
    } else if (ev.type === 'tool_call') {
      for (const s of chunker.flushComplete()) console.log(`${Date.now() - t0}ms sentence: ${s}`);
      calls.push(ev.call);
      console.log(`${Date.now() - t0}ms tool_call ${ev.call.name} ${ev.call.arguments}`);
    } else console.log(`${Date.now() - t0}ms done (${ev.finishReason})`);
  }
  for (const s of chunker.flush()) console.log(`end sentence: ${s}`);
  console.log(`round ${round}: ${info}, first token ${first} ms, total ${Date.now() - t0} ms`);
  if (!calls.length) break;
  // Fake tool results (no SpacetimeDB here).
  messages.push({ role: 'assistant', content: text, toolCalls: calls });
  for (const c of calls) {
    const content = c.name === 'set_topic' ? JSON.stringify({ ok: true, material: { concept: 'fractions-expand', summary: 'multiply top and bottom by the same number' }, notes: [] }) : 'ok';
    messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content });
  }
}
