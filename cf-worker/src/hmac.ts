// Dispatch signature check with WebCrypto: hex HMAC-SHA256(secret, `${ts}.${nonce}.${body}`),
// the same string the module signs (spacetimedb/src/hmac.ts signDispatch).
const enc = new TextEncoder();

export async function signHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison (equal length hex). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const MAX_SKEW_MS = 60_000;

/** '' = valid, else the reason (logged, never the body). */
export async function verifyDispatch(secret: string, h: { ts: string | null; nonce: string | null; sig: string | null }, body: string, nowMs: number): Promise<string> {
  if (!secret) return 'CF_DISPATCH_SECRET not set';
  if (!h.ts || !h.nonce || !h.sig) return 'missing signature headers';
  const ts = Number(h.ts);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > MAX_SKEW_MS) return 'timestamp outside the window';
  const want = await signHex(secret, `${h.ts}.${h.nonce}.${body}`);
  return safeEqual(want, h.sig.toLowerCase()) ? '' : 'bad signature';
}
