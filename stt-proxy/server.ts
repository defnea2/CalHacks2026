// stt-proxy: Cartesia's batch STT interface (POST /stt) on top of the ink-2 websocket.
//
// Why: ink-2, Cartesia's latest STT model, is websocket-only, and SpacetimeDB procedures can
// only make one-shot HTTP requests (ctx.http.fetch). This server accepts the exact batch request
// a procedure would send to https://api.cartesia.ai/stt, streams the whole buffer through
// wss://api.cartesia.ai/stt/websocket in one go, sends "finalize", and answers with the batch
// response shape. When SpacetimeDB gets async procedures/websockets, or Cartesia serves ink-2 in
// batch, point STT_BASE_URL at https://api.cartesia.ai and delete this file.
//
// Request (same as Cartesia batch):
//   POST /stt?encoding=pcm_s16le&sample_rate=16000
//   Authorization: Bearer <CARTESIA_API_KEY>      (forwarded as the websocket X-API-Key)
//   Cartesia-Version: 2026-08-14
//   multipart/form-data: file=<audio bytes>, model=ink-2, language=en (optional)
// Response 200: {"type":"transcript","text":..,"language":..,"duration":..,"request_id":..}
//
// Run: pnpm stt-proxy   (PORT default 8787, binds 127.0.0.1 only)
import http from 'node:http';
import WebSocket from 'ws';

const PORT = Number(process.env.STT_PROXY_PORT ?? 8787);
const CARTESIA_WS = 'wss://api.cartesia.ai/stt/websocket';
const DEFAULT_VERSION = '2026-08-14';
const WARM_SOCKETS = Number(process.env.STT_PROXY_WARM ?? 2);
/** Reopen warm sockets older than this, in case Cartesia closes idle connections. */
const MAX_IDLE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** Audio is sent in 100 ms frames, as fast as the socket accepts them. */
const FRAME_MS = 100;

const RAW_ENCODINGS: Record<string, number> = { pcm_s16le: 2, pcm_s32le: 4, pcm_f16le: 2, pcm_f32le: 4, pcm_mulaw: 1, pcm_alaw: 1 };

// ---------------------------------------------------------------- warm socket pool

type PoolKey = string;
interface Warm {
  ws: WebSocket;
  openedAt: number;
}
const pool = new Map<PoolKey, Warm[]>();

function wsUrl(model: string, encoding: string, sampleRate: number, version: string): string {
  const q = new URLSearchParams({ model, encoding, sample_rate: String(sampleRate), cartesia_version: version });
  return `${CARTESIA_WS}?${q}`;
}

function openSocket(url: string, apiKey: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { 'X-API-Key': apiKey } });
    const fail = (err: Error) => reject(err);
    ws.once('open', () => {
      ws.off('error', fail);
      ws.on('error', () => {}); // later errors surface through the request's handlers
      resolve(ws);
    });
    ws.once('error', fail);
    ws.once('unexpected-response', (_req, res) => reject(new HttpError(res.statusCode ?? 502, `websocket rejected: ${res.statusCode}`)));
  });
}

function refill(key: PoolKey, url: string, apiKey: string): void {
  const list = pool.get(key) ?? [];
  pool.set(key, list);
  const live = list.filter(w => w.ws.readyState === WebSocket.OPEN && Date.now() - w.openedAt < MAX_IDLE_MS);
  for (const w of list) if (!live.includes(w)) w.ws.close();
  list.length = 0;
  list.push(...live);
  for (let i = list.length; i < WARM_SOCKETS; i++) {
    openSocket(url, apiKey)
      .then(ws => {
        const entry = { ws, openedAt: Date.now() };
        list.push(entry);
        ws.once('close', () => {
          const at = list.indexOf(entry);
          if (at >= 0) list.splice(at, 1);
        });
      })
      .catch(err => console.warn('[stt-proxy] warm socket failed:', err.message));
  }
}

async function takeSocket(key: PoolKey, url: string, apiKey: string): Promise<WebSocket> {
  const list = pool.get(key) ?? [];
  while (list.length) {
    const w = list.shift()!;
    if (w.ws.readyState === WebSocket.OPEN && Date.now() - w.openedAt < MAX_IDLE_MS) {
      w.ws.removeAllListeners('close');
      refill(key, url, apiKey);
      return w.ws;
    }
    w.ws.close();
  }
  const ws = await openSocket(url, apiKey);
  refill(key, url, apiKey);
  return ws;
}

// ---------------------------------------------------------------- transcription

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'proxy_error') {
    super(message);
  }
}

interface TranscriptMessage {
  type: 'transcript' | 'flush_done' | 'done' | 'error';
  text?: string;
  is_final?: boolean;
  request_id?: string;
  message?: string;
  error_code?: string;
  status_code?: number;
}

async function transcribe(opts: {
  audio: Uint8Array;
  model: string;
  encoding: string;
  sampleRate: number;
  version: string;
  apiKey: string;
}): Promise<{ text: string; requestId: string }> {
  const url = wsUrl(opts.model, opts.encoding, opts.sampleRate, opts.version);
  const key = `${opts.apiKey}|${url}`;
  const ws = await takeSocket(key, url, opts.apiKey);
  return new Promise((resolve, reject) => {
    let text = '';
    let requestId = '';
    const timer = setTimeout(() => finish(new HttpError(504, 'ink-2 did not answer in time')), REQUEST_TIMEOUT_MS);
    const finish = (err?: Error) => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      // A socket that finished cleanly could be reused, but one finalize per socket keeps
      // requests isolated; warm sockets already hide the connect time.
      ws.close();
      if (err) reject(err);
      else resolve({ text, requestId });
    };
    const onMessage = (data: WebSocket.RawData) => {
      let msg: TranscriptMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.request_id) requestId = msg.request_id;
      if (msg.type === 'transcript' && msg.is_final && msg.text) text += msg.text; // deltas, concatenated as-is
      else if (msg.type === 'flush_done') finish();
      else if (msg.type === 'error') finish(new HttpError(msg.status_code ?? 502, msg.message ?? 'ink-2 error', msg.error_code));
    };
    const onClose = () => finish(new HttpError(502, 'ink-2 websocket closed early'));
    ws.on('message', onMessage);
    ws.on('close', onClose);

    const frame = Math.max(1, Math.round((opts.sampleRate * FRAME_MS) / 1000)) * (RAW_ENCODINGS[opts.encoding] ?? 2);
    for (let i = 0; i < opts.audio.length; i += frame) ws.send(opts.audio.subarray(i, i + frame));
    ws.send('finalize');
  });
}

// ---------------------------------------------------------------- HTTP

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleStt(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const t0 = performance.now();
  const auth = req.headers.authorization ?? '';
  const apiKey = auth.replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] ?? '');
  if (!apiKey) throw new HttpError(401, 'missing Authorization: Bearer <api key>', 'unauthorized');

  // Parse multipart/form-data with the built-in Fetch API.
  const body = await readBody(req);
  const form = await new Request('http://local/stt', {
    method: 'POST',
    headers: { 'content-type': String(req.headers['content-type'] ?? '') },
    body,
  })
    .formData()
    .catch(() => {
      throw new HttpError(400, 'body must be multipart/form-data with a `file` field', 'invalid_request');
    });
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, '`file` is required', 'invalid_request');
  const model = String(form.get('model') ?? 'ink-2');
  const language = String(form.get('language') ?? 'en');
  const encoding = url.searchParams.get('encoding') ?? 'pcm_s16le';
  const sampleRate = Number(url.searchParams.get('sample_rate') ?? 16000);
  if (!(encoding in RAW_ENCODINGS)) throw new HttpError(400, 'only raw PCM encodings are supported by this proxy', 'invalid_request');
  const audio = new Uint8Array(await file.arrayBuffer());
  const version = String(req.headers['cartesia-version'] ?? DEFAULT_VERSION);

  const { text, requestId } = await transcribe({ audio, model, encoding, sampleRate, version, apiKey });
  const duration = audio.length / RAW_ENCODINGS[encoding]! / sampleRate;
  sendJson(res, 200, { type: 'transcript', request_id: requestId, text: text.trim(), language, duration });
  console.log(`[stt-proxy] ${duration.toFixed(2)}s audio -> ${(performance.now() - t0).toFixed(0)} ms: ${JSON.stringify(text.trim())}`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true });
  if (req.method !== 'POST' || url.pathname !== '/stt') return sendJson(res, 404, { error_code: 'not_found', message: 'only POST /stt' });
  handleStt(req, res, url).catch((err: unknown) => {
    const e = err instanceof HttpError ? err : new HttpError(500, err instanceof Error ? err.message : String(err));
    console.warn(`[stt-proxy] ${e.status} ${e.message}`);
    sendJson(res, e.status, { error_code: e.code, title: 'STT proxy error', message: e.message });
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[stt-proxy] listening on http://127.0.0.1:${PORT}/stt -> ink-2 websocket`));
