// Cloudflare Worker entry (LLM_DISPATCH=cloudflare, docs/CLOUD_PLAN.md Part B).
//   POST /dispatch  HMAC-checked dispatch from the SpacetimeDB module -> 202, then the lesson runs in
//                   ctx.waitUntil (at most 30 s after the response; run.ts caps it below that).
//   GET  /health    ok
// Never logs the body (transcripts, memory, photos).
import { AnthropicProvider } from '../../worker/src/anthropic';
import { verifyDispatch } from './hmac';
import { runDispatch } from './run';
import { isDispatchBody, type Env, type WaitCtx } from './types';

const MAX_BODY = 4 * 1024 * 1024;

export function lessonLlm(env: Env) {
  const effort = (['low', 'medium', 'high'].includes(env.LESSON_EFFORT ?? '') ? env.LESSON_EFFORT : 'low') as 'low' | 'medium' | 'high';
  // Same settings as the Node worker's lesson LLM (worker/src/providers.ts createLessonLlm).
  return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || 'claude-haiku-5-5', effort, thinking: 'disabled', maxTokens: 4000 });
}

export async function handle(req: Request, env: Env, ctx: WaitCtx, deps: { run?: typeof runDispatch; now?: () => number } = {}): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname === '/health') return new Response('ok');
  if (req.method !== 'POST' || url.pathname !== '/dispatch') return new Response('not found', { status: 404 });
  const receivedAt = (deps.now ?? Date.now)();
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) return new Response('too large', { status: 413 });
  const text = await req.text();
  if (text.length > MAX_BODY) return new Response('too large', { status: 413 });
  const bad = await verifyDispatch(
    env.CF_DISPATCH_SECRET,
    { ts: req.headers.get('x-dispatch-ts'), nonce: req.headers.get('x-dispatch-nonce'), sig: req.headers.get('x-dispatch-signature') },
    text,
    receivedAt
  );
  if (bad) {
    console.warn(`dispatch rejected: ${bad}`);
    return new Response('unauthorized', { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  if (!isDispatchBody(body)) return new Response('bad dispatch', { status: 400 });
  const d = body;
  console.log(`[d${d.dispatchId} u${d.utteranceId} ${d.kind} t${d.turnIdx}] received ${receivedAt - d.builtAtMs} ms after the module built it (clock skew included)`);
  ctx.waitUntil(
    (deps.run ?? runDispatch)(d, { url: env.STDB_URL, db: env.STDB_DB, token: env.STDB_TOKEN, llm: lessonLlm(env), library: env.LESSON_LIBRARY !== 'false' }).catch(e =>
      console.error(`[d${d.dispatchId}] run failed: ${e instanceof Error ? e.message : String(e)}`)
    )
  );
  return new Response('accepted', { status: 202 });
}

export default {
  fetch: (req: Request, env: Env, ctx: WaitCtx) => handle(req, env, ctx),
};
