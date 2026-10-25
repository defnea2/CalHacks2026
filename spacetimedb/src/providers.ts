// Provider adapters on top of ctx.http.fetch (synchronous, one-shot). No SDKs in the module.
// SttProvider: Cartesia batch STT interface (served locally by stt-proxy -> ink-2).
// TtsProvider: Cartesia POST /tts/sse with word timestamps (or /tts/bytes), raw PCM16.
// Chat: OpenRouter chat completions, non-streaming, structured JSON output.
import { TimeDuration } from 'spacetimedb';
import { MODULE_DEFAULTS, VOICE_DEFAULTS } from '../../shared/src/config';
import type { SttResult, TtsRequest, TtsResult, TtsWordTimings } from '../../shared/src/types';
import type { PCtx } from './ctx';
import { settings } from './env';

const enc = new TextEncoder();

export class ProviderError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Hand-built multipart/form-data body (no FormData in the module runtime). */
export function multipart(
  fields: Array<{ name: string; value: string | Uint8Array; filename?: string; contentType?: string }>,
  boundary: string
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`;
    if (f.filename !== undefined) head += `; filename="${f.filename}"`;
    head += '\r\n';
    if (f.contentType) head += `Content-Type: ${f.contentType}\r\n`;
    head += '\r\n';
    parts.push(enc.encode(head));
    parts.push(typeof f.value === 'string' ? enc.encode(f.value) : f.value);
    parts.push(enc.encode('\r\n'));
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));
  return concatBytes(parts);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function base64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '==';
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '=';
  }
  return out;
}

function errText(status: number, body: string): string {
  return `HTTP ${status}: ${body.slice(0, 300)}`;
}

/** One phrase of 16 kHz PCM16 -> text. Throws ProviderError on HTTP failure. */
export function transcribe(ctx: PCtx, pcm: Uint8Array, language: string = MODULE_DEFAULTS.TTS_LANGUAGE): SttResult {
  const boundary = `----tutor${ctx.random.integerInRange(100000, 999999)}${pcm.length}`;
  const body = multipart(
    [
      { name: 'file', value: pcm, filename: 'phrase.raw', contentType: 'application/octet-stream' },
      { name: 'model', value: settings.sttModel(ctx) },
      { name: 'language', value: language },
    ],
    boundary
  );
  const url = `${settings.sttBaseUrl(ctx)}/stt?encoding=pcm_s16le&sample_rate=${VOICE_DEFAULTS.INPUT_SAMPLE_RATE}`;
  let res;
  try {
    res = ctx.http.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.cartesiaKey(ctx)}`,
        'Cartesia-Version': MODULE_DEFAULTS.CARTESIA_VERSION,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      timeout: TimeDuration.fromMillis(20_000),
    });
  } catch (e) {
    throw new ProviderError(0, `stt fetch failed: ${String(e)}`);
  }
  const text = res.text();
  if (res.status !== 200) throw new ProviderError(res.status, errText(res.status, text));
  let json: { text?: unknown; duration?: unknown };
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderError(502, 'stt: response is not JSON');
  }
  return {
    text: typeof json.text === 'string' ? json.text.trim() : '',
    durationS: typeof json.duration === 'number' ? json.duration : pcm.length / 2 / VOICE_DEFAULTS.INPUT_SAMPLE_RATE,
  };
}

export function ttsRequest(ctx: PCtx, text: string): TtsRequest {
  return {
    text,
    voiceId: settings.voiceId(ctx),
    model: settings.ttsModel(ctx),
    sampleRate: settings.ttsSampleRate(ctx),
    speed: MODULE_DEFAULTS.TTS_SPEED,
    language: MODULE_DEFAULTS.TTS_LANGUAGE,
  };
}

/** One sentence -> raw PCM16 mono (+ word timestamps via /tts/sse when enabled). Throws
 *  ProviderError on HTTP failure. */
export function synthesize(ctx: PCtx, req: TtsRequest): TtsResult {
  const sse = MODULE_DEFAULTS.TTS_WORD_TIMESTAMPS;
  let res;
  try {
    res = ctx.http.fetch(`https://api.cartesia.ai/tts/${sse ? 'sse' : 'bytes'}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.cartesiaKey(ctx)}`,
        'Cartesia-Version': MODULE_DEFAULTS.CARTESIA_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: req.model,
        transcript: req.text,
        voice: { mode: 'id', id: req.voiceId },
        language: req.language,
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: req.sampleRate },
        generation_config: { speed: req.speed },
        ...(sse ? { add_timestamps: true } : {}),
      }),
      timeout: TimeDuration.fromMillis(20_000),
    });
  } catch (e) {
    throw new ProviderError(0, `tts fetch failed: ${String(e)}`);
  }
  if (res.status !== 200) throw new ProviderError(res.status, errText(res.status, res.text()));
  if (sse) return { ...parseTtsSse(res.text()), sampleRate: req.sampleRate };
  const pcm = res.bytes();
  if (pcm.length === 0) throw new ProviderError(502, 'tts: empty audio');
  return { pcm, sampleRate: req.sampleRate };
}

/**
 * Cartesia /tts/sse body (read in full; procedures cannot stream): frames of `event: <type>` +
 * `data: <json>`. `chunk` carries base64 PCM, `timestamps` word_timestamps {words, start, end}
 * in seconds, `error` a message, `done` ends the stream.
 */
export function parseTtsSse(body: string): { pcm: Uint8Array; words: TtsWordTimings } {
  const audio: Uint8Array[] = [];
  const words: TtsWordTimings = { words: [], startsMs: [], endsMs: [] };
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim())
      .join('');
    if (!data) continue;
    let ev: { type?: string; data?: string; message?: string; title?: string; word_timestamps?: { words?: unknown; start?: unknown; end?: unknown } };
    try {
      ev = JSON.parse(data);
    } catch {
      continue; // keep-alive or partial frame
    }
    if (ev.type === 'chunk' && typeof ev.data === 'string') audio.push(fromBase64(ev.data));
    else if (ev.type === 'timestamps' && ev.word_timestamps) {
      const w = ev.word_timestamps;
      const ws = Array.isArray(w.words) ? w.words : [];
      const st = Array.isArray(w.start) ? w.start : [];
      const en = Array.isArray(w.end) ? w.end : [];
      for (let i = 0; i < ws.length; i++) {
        const a = Number(st[i]);
        const b = Number(en[i]);
        if (typeof ws[i] !== 'string' || !Number.isFinite(a)) continue;
        words.words.push(ws[i] as string);
        words.startsMs.push(Math.max(0, Math.round(a * 1000)));
        words.endsMs.push(Math.max(0, Math.round((Number.isFinite(b) ? b : a) * 1000)));
      }
    } else if (ev.type === 'error') {
      throw new ProviderError(502, `tts error: ${ev.title ?? ''} ${ev.message ?? ''}`.trim());
    }
  }
  const pcm = concatBytes(audio);
  if (pcm.length === 0) throw new ProviderError(502, 'tts: empty audio');
  return { pcm, words };
}

const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Standard base64 -> bytes (no atob in the module runtime). Ignores padding and whitespace. */
export function fromBase64(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let n = 0;
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c]! : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

/** Non-streaming OpenRouter chat completion with a JSON schema response. Returns parsed JSON. */
export function chatJson(
  ctx: PCtx,
  opts: { system: string; user: string; schemaName: string; schema: Record<string, unknown>; maxTokens?: number }
): unknown {
  let res;
  try {
    res = ctx.http.fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.openrouterKey(ctx)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.extractionModel(ctx),
        stream: false,
        temperature: 0,
        max_tokens: opts.maxTokens ?? 1500,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: opts.schemaName, strict: true, schema: opts.schema } },
      }),
      timeout: TimeDuration.fromMillis(60_000),
    });
  } catch (e) {
    throw new ProviderError(0, `openrouter fetch failed: ${String(e)}`);
  }
  const text = res.text();
  if (res.status !== 200) throw new ProviderError(res.status, errText(res.status, text));
  let content: unknown;
  try {
    const json = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: string } };
    if (json.error) throw new ProviderError(502, `openrouter error: ${json.error.message ?? 'unknown'}`);
    content = json.choices?.[0]?.message?.content;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(502, 'openrouter: response is not JSON');
  }
  if (typeof content !== 'string') throw new ProviderError(502, 'openrouter: no message content');
  // Some models wrap JSON in a code fence despite response_format.
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new ProviderError(502, 'openrouter: content is not valid JSON');
  }
}
