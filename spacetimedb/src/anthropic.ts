// Non-streaming Anthropic Messages API client for module procedures (ctx.http.fetch is
// synchronous and returns the whole response, so the SDK can't run here: raw HTTP).
// Structured JSON output via output_config.format (json_schema, GA, no beta header).
// Reused by memory extraction / session summaries; meant for any background JSON task
// (e.g. classroom summaries, student clustering).
import { TimeDuration } from 'spacetimedb';
import { MODULE_DEFAULTS } from '../../shared/src/config';
import type { PCtx } from './ctx';
import { settings } from './env';
import { ProviderError } from './providers';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * - `http`: network failure or non-200 status (status 0 = fetch threw). Retryable.
 * - `refusal`: stop_reason "refusal". Not retryable (no server-side fallback for Haiku).
 * - `truncated`: stop_reason "max_tokens". Output incomplete; retryable (or raise maxTokens).
 * - `parse`: response or text block is not the expected JSON. Retryable.
 */
export type AnthropicErrorKind = 'http' | 'refusal' | 'truncated' | 'parse';

/** Extends ProviderError so existing `catch (e instanceof ProviderError)` paths keep working. */
export class AnthropicError extends ProviderError {
  constructor(readonly kind: AnthropicErrorKind, status: number, message: string) {
    super(status, message);
  }
}

export interface AnthropicJsonOptions {
  system: string;
  user: string;
  /** JSON schema of the answer. Subset: objects need additionalProperties:false; no
   *  minimum/maximum/minLength/maxLength; enums of primitives only. */
  schema: Record<string, unknown>;
  /** Thinking depth / token spend. Haiku 5.5 default is medium. */
  effort?: 'low' | 'medium' | 'high';
  /** Ceiling for thinking + answer tokens. */
  maxTokens?: number;
  /** Overrides env ANTHROPIC_EXTRACTION_MODEL. */
  model?: string;
  timeoutMs?: number;
}

export interface AnthropicJsonResult<T = unknown> {
  value: T;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** Builds the request body (exported for tests). No temperature/top_p/top_k: 400 on this model. */
export function anthropicJsonBody(model: string, opts: AnthropicJsonOptions): Record<string, unknown> {
  return {
    model,
    max_tokens: opts.maxTokens ?? 4000,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
    output_config: {
      effort: opts.effort ?? 'low',
      format: { type: 'json_schema', schema: opts.schema },
    },
  };
}

/** One structured-output call. Returns the parsed JSON or throws AnthropicError. */
export function callAnthropicJson<T = unknown>(ctx: PCtx, opts: AnthropicJsonOptions): AnthropicJsonResult<T> {
  const model = opts.model ?? settings.anthropicModel(ctx);
  let res;
  try {
    res = ctx.http.fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': settings.anthropicKey(ctx),
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(anthropicJsonBody(model, opts)),
      timeout: TimeDuration.fromMillis(opts.timeoutMs ?? MODULE_DEFAULTS.ANTHROPIC_TIMEOUT_MS),
    });
  } catch (e) {
    throw new AnthropicError('http', 0, `anthropic fetch failed: ${String(e)}`);
  }
  const text = res.text();
  if (res.status !== 200) {
    let detail = text.slice(0, 300);
    try {
      const err = (JSON.parse(text) as { error?: { type?: string; message?: string } }).error;
      if (err) detail = `${err.type ?? 'error'}: ${err.message ?? ''}`;
    } catch {
      /* keep raw body */
    }
    throw new AnthropicError('http', res.status, `anthropic HTTP ${res.status}: ${detail}`);
  }
  let msg: {
    model?: string;
    stop_reason?: string;
    stop_details?: { category?: string | null; explanation?: string } | null;
    content?: Array<{ type?: string; text?: unknown }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  try {
    msg = JSON.parse(text);
  } catch {
    throw new AnthropicError('parse', 502, 'anthropic: response is not JSON');
  }
  if (msg.stop_reason === 'refusal') {
    const d = msg.stop_details;
    throw new AnthropicError('refusal', 200, `anthropic refusal${d?.category ? ` (${d.category})` : ''}${d?.explanation ? `: ${d.explanation}` : ''}`);
  }
  if (msg.stop_reason === 'max_tokens') throw new AnthropicError('truncated', 200, 'anthropic: hit max_tokens, output incomplete');
  // Adaptive thinking: the response may start with thinking blocks; the answer is the text block(s).
  const answer = (Array.isArray(msg.content) ? msg.content : [])
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('');
  if (!answer.trim()) throw new AnthropicError('parse', 502, `anthropic: no text block (stop_reason ${msg.stop_reason ?? '?'})`);
  let value: T;
  try {
    value = JSON.parse(answer) as T;
  } catch {
    throw new AnthropicError('parse', 502, 'anthropic: text block is not valid JSON');
  }
  return {
    value,
    model: msg.model ?? model,
    usage: { inputTokens: msg.usage?.input_tokens ?? 0, outputTokens: msg.usage?.output_tokens ?? 0 },
  };
}
