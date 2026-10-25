// Real-model check of inline board markers (no SpacetimeDB): does the model write ⟦id⟧ markers
// in its speech, pass matching ids to the board tool, and put every tool call after its text?
// `pnpm --filter worker smoke:markers [tries] [fresh]`. `fresh`: first turn of a session (initial
// phase, no topic yet, like the E2E fixtures), else mid-lesson with the topic set.
// Prints a per-try line and the rates, never keys.
import fs from 'node:fs';
import { markerIds, markerReminder, pack, prepareSentence, SentenceChunker, TOOL_NAMES, type ChatMessage } from '@tutor/shared';
import { loadConfig } from './env';
import { createLlm } from './providers';
import { buildSystemPrompt } from './prompt';
import { createToolDefs } from './tools/index';

const tries = Number(process.argv[2] ?? 10);
// SMOKE_TOPIC_FILE: a real set_topic result (library material is long and changes behaviour).
const topicResult = process.env.SMOKE_TOPIC_FILE
  ? fs.readFileSync(process.env.SMOKE_TOPIC_FILE, 'utf8')
  : JSON.stringify({ ok: true, material: { summary: 'multiply top and bottom by the same number' }, notes: [] });
const cfg = loadConfig();
const tools = createToolDefs(pack).map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
const { llm, info } = createLlm(cfg);
const fresh = process.argv[3] === 'fresh';
const phase = fresh ? pack.initialPhase : pack.phases[Math.min(1, pack.phases.length - 1)]!.id;
const category = pack.taxonomy[0]!.key;

const STUDENT = fresh
  ? ['I multiply the top and the bottom by 4.', 'I think I just add 10 to the bottom, so it is 2 over 12?', 'Um, I am not sure. Do I make the top bigger?']
  : [
  "I don't get how two thirds can be the same as eight twelfths. It has bigger numbers!",
  'Can you show me with a picture why one half is the same as two quarters?',
  'Why do I multiply the top and the bottom by the same number?',
];

function conversation(user: string): ChatMessage[] {
  if (fresh) {
    return [
      { role: 'system', content: buildSystemPrompt(pack, tools) },
      {
        role: 'system',
        content: `Learner: Mia, 10, grade 5, likes pictures.\nOriginal task: Expand 2/3 so the bottom number is 12.\nCurrent phase: ${phase}\nBoard right now: empty\n\nTopic: not set yet. Find it and call set_topic.`,
      },
      { role: 'user', content: user },
    ];
  }
  return [
    { role: 'system', content: buildSystemPrompt(pack, tools) },
    {
      role: 'system',
      content: `Learner: Mia, 10, grade 5, likes pictures.\nOriginal task: Expand 2/3 so the bottom number is 12.\nCurrent phase: ${phase}\nBoard right now: empty\n\nTopic: ${category}\nLibrary material: {"summary":"multiply top and bottom by the same number"}`,
    },
    { role: 'user', content: 'Hi, I need help with my fractions homework.' },
    { role: 'assistant', content: 'Sure! Let us look at it together. What part feels tricky?' },
    { role: 'user', content: user },
  ];
}

const stats = { tries: 0, boardCalls: 0, withId: 0, matched: 0, repliesWithBoard: 0, repliesAllMatched: 0, toolsAtEnd: 0, spokenMarker: 0, orphanMarkers: 0, failed: 0 };
for (let i = 0; i < tries; i++) {
  const user = STUDENT[i % STUDENT.length]!;
  const t0 = Date.now();
  let text = '';
  let textAfterTool = false;
  let sawTool = false;
  const calls: { name: string; arguments: string }[] = [];
  const chunker = new SentenceChunker();
  const sentences: string[] = [];
  // Like ReplyRun: a round with a query tool (set_topic) gets its result and a second round.
  const messages = conversation(user);
  let rounds = 0;
  try {
    for (let round = 0; round < 2; round++) {
      rounds++;
      let roundText = '';
      let raw: unknown;
      const roundCalls: { id: string; name: string; arguments: string }[] = [];
      for await (const ev of llm.stream({ messages, tools, signal: new AbortController().signal })) {
        if (ev.type === 'text') {
          if (sawTool && ev.delta.trim()) textAfterTool = true;
          text += ev.delta;
          roundText += ev.delta;
          sentences.push(...chunker.push(ev.delta));
        } else if (ev.type === 'tool_call') {
          sawTool = true;
          calls.push(ev.call);
          roundCalls.push(ev.call);
        } else if (ev.type === 'done') raw = ev.raw;
      }
      sentences.push(...chunker.flush());
      sawTool = false;
      if (!roundCalls.some(c => c.name === TOOL_NAMES.setTopic)) break;
      messages.push({ role: 'assistant', content: roundText, toolCalls: roundCalls, ...(raw !== undefined ? { raw } : {}) });
      for (const c of roundCalls) {
        const content = c.name === TOOL_NAMES.setTopic ? topicResult + (process.env.SMOKE_REMINDER ? `\n\n${markerReminder(TOOL_NAMES.showBoardItem)}` : '') : 'ok';
        messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content });
      }
      text += ' ';
    }
  } catch (e) {
    stats.failed++;
    console.log(`try ${i}: failed ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  sentences.push(...chunker.flush());
  stats.tries++;
  const ids = markerIds(text);
  const board = calls.filter(c => c.name === TOOL_NAMES.showBoardItem);
  const boardIds = board.map(c => {
    try {
      return String((JSON.parse(c.arguments || '{}') as { id?: unknown }).id ?? '').toLowerCase();
    } catch {
      return '';
    }
  });
  stats.boardCalls += board.length;
  stats.withId += boardIds.filter(Boolean).length;
  const matched = boardIds.filter(id => id && ids.includes(id)).length;
  stats.matched += matched;
  if (board.length) stats.repliesWithBoard++;
  if (board.length && matched === board.length) stats.repliesAllMatched++;
  if (!textAfterTool) stats.toolsAtEnd++;
  stats.orphanMarkers += ids.filter(id => !boardIds.includes(id)).length;
  const speech = sentences.map(s => prepareSentence(s).speech).join(' ');
  if (/⟦|⟧|\[\[|marker/i.test(speech)) stats.spokenMarker++;
  console.log(
    `try ${i} (${rounds} rounds, ${Date.now() - t0} ms): markers [${ids.join(',')}] board ids [${boardIds.join(',')}] tools ${calls.map(c => c.name).join(',') || '-'}${textAfterTool ? ' TEXT-AFTER-TOOL' : ''}\n  text: ${text.replace(/\s+/g, ' ').trim()}` +
      board.map(c => `\n  ${c.name} ${c.arguments.slice(0, 160)}`).join('')
  );
}
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '-');
console.log(`\n${info}, ${stats.tries} tries (${stats.failed} failed)`);
console.log(`replies with a board call: ${stats.repliesWithBoard}/${stats.tries}`);
console.log(`board calls with id: ${stats.withId}/${stats.boardCalls} (${pct(stats.withId, stats.boardCalls)}), with matching marker: ${stats.matched}/${stats.boardCalls} (${pct(stats.matched, stats.boardCalls)})`);
console.log(`replies where every board call has its marker: ${stats.repliesAllMatched}/${stats.repliesWithBoard} (${pct(stats.repliesAllMatched, stats.repliesWithBoard)})`);
console.log(`replies with all tool calls after the text: ${stats.toolsAtEnd}/${stats.tries} (${pct(stats.toolsAtEnd, stats.tries)})`);
console.log(`markers without a tool call: ${stats.orphanMarkers}; replies whose speech leaks a marker: ${stats.spokenMarker}`);
