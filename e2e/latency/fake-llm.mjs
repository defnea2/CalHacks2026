// Local OpenAI-compatible streaming chat server for latency runs (no internet).
// Point the worker at it: LLM_BASE_URL=http://127.0.0.1:8799/v1 (temporary override on this branch).
// Every request streams N sentences, then (if tools are offered) one show_board_item call, finish.
// Env: FAKE_LLM_PORT (8799), FAKE_TTFT_MS (first token delay, 0), FAKE_TOKEN_MS (gap per token, 12),
//      FAKE_SENTENCES (4). Logs `LAT {...}` lines like the worker.
import http from 'node:http';

const PORT = Number(process.env.FAKE_LLM_PORT ?? 8799);
const TTFT = Number(process.env.FAKE_TTFT_MS ?? 0);
const TOKEN_MS = Number(process.env.FAKE_TOKEN_MS ?? 12);
const N = Number(process.env.FAKE_SENTENCES ?? 4);
const SENTENCES = [
  'Nice, you multiplied the top and the bottom by four.',
  'That keeps the fraction the same size, just cut into smaller pieces.',
  'So two thirds becomes eight twelfths on our board.',
  'Can you tell me what happens if we multiply by three instead?',
  'Take your time and say your answer out loud.',
  'I will write your idea on the board next to mine.',
];
const lat = (ev, d = {}) => process.stdout.write(`LAT ${JSON.stringify({ ev, now: Date.now(), ...d })}\n`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let reqNo = 0;

http
  .createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const t0 = Date.now();
    let body = '';
    for await (const c of req) body += c;
    const n = ++reqNo;
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {}
    const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
    lat('fake.request', { n, firstByteAt: t0, bodyBytes: body.length, msgs: parsed.messages?.length ?? 0, tools: hasTools });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const id = `fake-${n}`;
    const send = (delta, finish = null) =>
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      );
    if (TTFT) await sleep(TTFT);
    send({ role: 'assistant', content: '' });
    let first = true;
    // Word tokens with a leading space (like real BPE streams), so a sentence's final "." arrives
    // one token gap before the next sentence starts: the chunker's look-ahead cost is visible.
    const speak = async text => {
      for (const [k, w] of text.split(' ').entries()) {
        if (!first && TOKEN_MS) await sleep(TOKEN_MS);
        if (first) lat('fake.firstToken', { n });
        send({ content: (first || k > 0 ? (first && k === 0 ? '' : ' ') : ' ') + w });
        first = false;
      }
    };
    await speak(SENTENCES[0]);
    for (let i = 1; i < N; i++) await speak(SENTENCES[i % SENTENCES.length]);
    if (hasTools) {
      const args = JSON.stringify({ kind: 'equation', content: { latex: '\\frac{2}{3} = \\frac{8}{12}', caption: 'times 4' } });
      send({ tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: 'show_board_item', arguments: '' } }] });
      for (let i = 0; i < args.length; i += 24) {
        if (TOKEN_MS) await sleep(TOKEN_MS);
        send({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 24) } }] });
      }
      lat('fake.toolSent', { n });
    }
    send({}, hasTools ? 'tool_calls' : 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
    lat('fake.done', { n });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`fake LLM on http://127.0.0.1:${PORT}/v1 (ttft ${TTFT} ms, ${TOKEN_MS} ms/token)`));
