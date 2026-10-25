// Smoke test of the configured LLM provider with the real prompts and tools (no SpacetimeDB).
// `pnpm --filter worker smoke:llm ["student text"]`. Prints events and timings, never keys.
//   1. Opening reply (the tutor speaks first; no student turn).
//   2. Reply to a student turn with the tool loop. A successful set_phase appends the new phase
//      block after the tool results (append-only, as ReplyRun does; the system prompt never changes).
// For every reply it prints the first sentence's word count and whether it ends with a next step.
import { pack, renderPhaseBlock, SentenceChunker, normalizeForSpeech, TOOL_NAMES, type ChatMessage } from '@tutor/shared';
import { loadConfig } from './env';
import { createLlm } from './providers';
import { buildMessages, buildSystemPrompt } from './prompt';
import { endsWithNextStep } from './reply';
import { createToolDefs } from './tools/index';

const cfg = loadConfig();
const tools = createToolDefs(pack).map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
const { llm, info } = createLlm(cfg);
const system = buildSystemPrompt(pack, tools);
const context = `Learner: Mia, 10, grade 5, likes pictures.\nOriginal task: Expand 2/3 so the bottom number is 12.\nCurrent phase: ${pack.initialPhase}\nBoard right now: empty`;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const ctrl = new AbortController();
const phaseOf = (block: string) => pack.phases.filter(p => block.includes(p.instructions)).map(p => p.id);

async function reply(label: string, messages: ChatMessage[], startPhase: string): Promise<{ text: string; sentences: string[] }> {
  console.log(`\n=== ${label} (${info}) ===`);
  let phase = startPhase;
  let said = '';
  const sentences: string[] = [];
  for (let round = 0; round < 3; round++) {
    const blocks = messages.filter(m => m.role === 'system' && phaseOf(String(m.content)).length);
    const latest = blocks.at(-1);
    console.log(
      `round ${round}: system prompt unchanged ${messages[0]!.content === system}; phase blocks in history: ${blocks.length}, latest = [${latest ? phaseOf(String(latest.content)) : ''}] (expected [${phase}])`
    );
    const t0 = Date.now();
    let first = 0;
    let text = '';
    let raw: unknown;
    const calls: { id: string; name: string; arguments: string }[] = [];
    const chunker = new SentenceChunker();
    const say = (s: string, at: string) => {
      sentences.push(s);
      console.log(`${at} sentence ${sentences.length - 1}: ${s}\n        speech: ${normalizeForSpeech(s)}`);
    };
    for await (const ev of llm.stream({ messages, tools: round === 2 ? [] : tools, signal: ctrl.signal })) {
      if (!first && ev.type !== 'done') first = Date.now() - t0;
      if (ev.type === 'text') {
        text += ev.delta;
        for (const s of chunker.push(ev.delta)) say(s, `${Date.now() - t0}ms`);
      } else if (ev.type === 'tool_call') {
        for (const s of chunker.flushComplete()) say(s, `${Date.now() - t0}ms`);
        calls.push(ev.call);
        console.log(`${Date.now() - t0}ms tool_call ${ev.call.name} ${ev.call.arguments}`);
      } else {
        raw = ev.raw;
        console.log(`${Date.now() - t0}ms done (${ev.finishReason})`);
      }
    }
    for (const s of chunker.flush()) say(s, 'end');
    if (text.trim()) said = `${said} ${text.trim()}`.trim();
    console.log(`round ${round}: first token ${first} ms, total ${Date.now() - t0} ms`);
    if (!calls.length) break;
    // Fake tool results (no SpacetimeDB here). set_phase "succeeds" for any pack phase.
    messages.push({ role: 'assistant', content: text, toolCalls: calls, ...(raw !== undefined ? { raw } : {}) });
    let query = false;
    let changed = '';
    for (const c of calls) {
      let content = 'ok';
      if (c.name === TOOL_NAMES.setTopic) {
        query = true;
        content = JSON.stringify({ ok: true, material: { concept: 'fractions-expand', summary: 'multiply top and bottom by the same number' }, notes: [] });
      } else if (c.name === TOOL_NAMES.setPhase) {
        const to = (JSON.parse(c.arguments || '{}') as { phase?: string }).phase ?? '';
        if (pack.phases.some(p => p.id === to)) changed = to;
        else content = `error: unknown phase ${to}`;
      }
      messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content });
    }
    if (changed && changed !== phase) {
      console.log(`set_phase ${phase} -> ${changed}: appending the new phase block after the tool results`);
      phase = changed;
      messages.push({ role: 'system', content: renderPhaseBlock(pack, phase, true) });
    }
    if (!query && endsWithNextStep(said)) break; // same rule as ReplyRun
  }
  const last = sentences.at(-1) ?? '';
  console.log(`--> first sentence: ${sentences.length ? words(sentences[0]!) : 0} words; ends with a question: ${/\?\s*$/.test(last)} ("${last}")`);
  return { text: said, sentences };
}

// 1. Opening.
const opening = buildMessages({
  system,
  context,
  turns: [],
  current: { opening: pack.prompts.opening },
  recentTurns: 12,
  image: '',
  phaseBlock: renderPhaseBlock(pack, pack.initialPhase),
});
const o = await reply('opening reply (tutor speaks first)', opening, pack.initialPhase);

// 2. Student answers; the tutor should find the gap and move on with set_phase.
const student =
  process.argv[2] ??
  "Just guide me. I don't get how 2/3 can be the same as 8/12, it has bigger numbers! Oh wait, is it like a pizza with more but smaller slices?";
const msgs = buildMessages({
  system,
  context: `${context}\nSmoke test: the diagnosis is done (the student mixes up "bigger numbers" with "a bigger amount"). In this reply call set_topic and set_phase to ${pack.phases[1]!.id}, right after your first sentence.`,
  turns: [{ sessionId: 1n, idx: 0, role: 'tutor', text: o.text, status: 'done', utteranceId: 1n, interrupted: false }],
  current: { idx: 1, text: student },
  recentTurns: 12,
  image: '',
  phaseBlock: renderPhaseBlock(pack, pack.initialPhase),
});
await reply('student reply with set_phase', msgs, pack.initialPhase);
