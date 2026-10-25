// Smoke test of the OpenRouter provider with the real prompts and tools (no SpacetimeDB).
// `pnpm --filter worker smoke:llm ["student text"]`. Prints events and timings, never keys.
//   1. Opening reply (the tutor speaks first; no student turn).
//   2. Reply to a student turn with the tool loop. A successful set_phase swaps the phase
//      instructions in the system prompt for the next round, as ReplyRun does.
// For every reply it prints the first sentence's word count and whether it ends with a next step.
import { pack, phaseInstructions, SentenceChunker, normalizeForSpeech, TOOL_NAMES, type ChatMessage } from '@tutor/shared';
import { loadConfig } from './env';
import { OpenRouterProvider } from './llm';
import { buildMessages, buildSystemPrompt } from './prompt';
import { endsWithNextStep } from './reply';
import { createToolDefs } from './tools/index';

const cfg = loadConfig();
const tools = createToolDefs(pack).map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
const llm = new OpenRouterProvider({ apiKey: cfg.openrouterApiKey, model: cfg.openrouterModel, reasoningEffort: cfg.reasoningEffort });
const context = (phase: string) =>
  `Learner: Mia, 10, grade 5, likes pictures.\nOriginal task: Expand 2/3 so the bottom number is 12.\nCurrent phase: ${phase}\nBoard right now: empty`;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const ctrl = new AbortController();

async function reply(label: string, messages: ChatMessage[], startPhase: string): Promise<{ text: string; sentences: string[] }> {
  console.log(`\n=== ${label} ===`);
  let phase = startPhase;
  let all = '';
  const sentences: string[] = [];
  for (let round = 0; round < 3; round++) {
    // Per-call system prompt from the current phase (only that phase's block).
    messages[0] = { role: 'system', content: buildSystemPrompt(pack, tools, phase) };
    messages[1] = { role: 'system', content: context(phase) };
    const sys = String(messages[0].content);
    const blocks = pack.phases.filter(p => sys.includes(p.instructions)).map(p => p.id);
    console.log(`round ${round}: system prompt phase block = [${blocks.join(', ')}] (expected [${phase}])`);
    const t0 = Date.now();
    let first = 0;
    let text = '';
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
      } else console.log(`${Date.now() - t0}ms done (${ev.finishReason})`);
    }
    for (const s of chunker.flush()) say(s, 'end');
    all += (all && text ? ' ' : '') + text;
    console.log(`round ${round}: model ${cfg.openrouterModel}, first token ${first} ms, total ${Date.now() - t0} ms`);
    if (!calls.length) break;
    // Fake tool results (no SpacetimeDB here). set_phase "succeeds" for any pack phase.
    messages.push({ role: 'assistant', content: text, toolCalls: calls });
    let query = false;
    for (const c of calls) {
      let content = 'ok';
      if (c.name === TOOL_NAMES.setTopic) {
        query = true;
        content = JSON.stringify({ ok: true, material: { concept: 'fractions-expand', summary: 'multiply top and bottom by the same number' }, notes: [] });
      } else if (c.name === TOOL_NAMES.setPhase) {
        const to = (JSON.parse(c.arguments || '{}') as { phase?: string }).phase ?? '';
        if (phaseInstructions(pack, to)) {
          console.log(`set_phase ${phase} -> ${to}: next round gets the new phase block`);
          phase = to;
        } else content = `error: unknown phase ${to}`;
      }
      messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content });
    }
    if (!query && endsWithNextStep(all)) break; // same rule as ReplyRun
  }
  const firstWords = sentences.length ? words(sentences[0]!) : 0;
  const last = sentences.at(-1) ?? '';
  console.log(`--> first sentence: ${firstWords} words; last sentence ends with a question: ${/\?\s*$/.test(last)} ("${last}")`);
  return { text: all, sentences };
}

// 1. Opening.
const opening = buildMessages({
  system: buildSystemPrompt(pack, tools, pack.initialPhase),
  context: context(pack.initialPhase),
  turns: [],
  current: { opening: pack.prompts.opening },
  recentTurns: 12,
  image: '',
});
const o = await reply('opening reply (tutor speaks first)', opening, pack.initialPhase);

// 2. Student answers; the tutor should find the gap and may move on with set_phase.
const student = process.argv[2] ?? "Just guide me. I don't get how 2/3 can be the same as 8/12, it has bigger numbers! I think I get it now that you said it's like a pizza with more slices.";
const msgs = buildMessages({
  system: buildSystemPrompt(pack, tools, pack.initialPhase),
  context: context(pack.initialPhase),
  turns: [{ sessionId: 1n, idx: 0, role: 'tutor', text: o.text, status: 'done', utteranceId: 1n, interrupted: false }],
  current: { idx: 1, text: student },
  recentTurns: 12,
  image: '',
});
msgs.splice(2, 0, {
  role: 'system',
  content: `Smoke test: the diagnosis is done (the student mixes up "bigger numbers" with "bigger amount"). Call set_topic and set_phase to ${pack.phases[1]!.id} in this reply, together with your first sentence.`,
});
await reply('student reply with set_phase', msgs, pack.initialPhase);
