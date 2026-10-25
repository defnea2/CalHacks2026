import { describe, expect, it } from 'vitest';
import { clearToken, loadToken, saveToken, tokenKey, type TokenEnv } from '../src/lib/token';
import { formatCode, normalizeCode } from '@tutor/shared/auth';

function mem() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}
const env = (search = '', local = mem(), session = mem()): TokenEnv & { local: ReturnType<typeof mem>; session: ReturnType<typeof mem> } => ({ local, session, search });
const URI = 'ws://127.0.0.1:3000';

describe('device token', () => {
  it('is kept per server + database in localStorage (every tab = the same device)', () => {
    const e = env();
    expect(loadToken(e, URI, 'db')).toBeUndefined();
    saveToken(e, URI, 'db', 'tok-1');
    expect(loadToken(e, URI, 'db')).toBe('tok-1');
    expect(loadToken(e, URI, 'other')).toBeUndefined();
    expect(loadToken(e, 'wss://maincloud.spacetimedb.com', 'db')).toBeUndefined();
    expect(e.local.m.get(tokenKey(URI + '/', 'db'))).toBe('tok-1');
    clearToken(e, URI, 'db');
    expect(loadToken(e, URI, 'db')).toBeUndefined();
  });

  it('?tabIdentity=1 gives this tab its own identity (sessionStorage), sticky without the flag', () => {
    const local = mem();
    const session = mem();
    saveToken(env('', local, session), URI, 'db', 'device');
    const tab = env('?tabIdentity=1', local, session);
    expect(loadToken(tab, URI, 'db')).toBeUndefined();
    saveToken(tab, URI, 'db', 'tab');
    expect(loadToken(env('?student=3', local, session), URI, 'db')).toBe('tab');
    expect(loadToken(env('', local, mem()), URI, 'db')).toBe('device');
    // ?tabIdentity=new starts over.
    expect(loadToken(env('?tabIdentity=new', local, session), URI, 'db')).toBeUndefined();
  });

  it('works without storage (private mode, throwing storage)', () => {
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    const e: TokenEnv = { local: throwing, session: null, search: '' };
    expect(() => saveToken(e, URI, 'db', 'x')).not.toThrow();
    expect(loadToken(e, URI, 'db')).toBeUndefined();
    expect(loadToken({ local: null, session: null, search: '' }, URI, 'db')).toBeUndefined();
  });
});

describe('sign-in codes (shared)', () => {
  it('normalizes what children type and formats for display', () => {
    expect(normalizeCode(' k7q-2m9 ')).toBe('K7Q2M9');
    expect(formatCode('K7Q2M9')).toBe('K7Q-2M9');
  });
});
