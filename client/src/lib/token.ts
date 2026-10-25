// Persistent device identity: the SpacetimeDB token of this browser, per server + database, so a
// reload (or the next day) keeps the same identity and with it the accounts it owns.
//
// localStorage by default: every tab of this browser is the same device. `?tabIdentity=1` (or
// `?tabIdentity=new` for a fresh one) switches this tab to its own identity in sessionStorage,
// for testing several students in one browser. Storage may be missing or throw (private mode,
// blocked site data): then the tab simply gets a fresh identity per load, as before.

const PREFIX = 'fibonacci.token:';
const TAB_FLAG = 'fibonacci.tabIdentity';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export interface TokenEnv {
  local: Store | null;
  session: Store | null;
  search: string;
}

export function browserTokenEnv(): TokenEnv {
  return {
    local: safe(() => window.localStorage, null),
    session: safe(() => window.sessionStorage, null),
    search: safe(() => window.location.search, ''),
  };
}

export function tokenKey(uri: string, db: string): string {
  return `${PREFIX}${uri.replace(/\/+$/, '')}/${db}`;
}

/** Where this tab keeps its token. A `?tabIdentity` flag sticks to the tab (sessionStorage). */
export function tokenStore(env: TokenEnv): Store | null {
  const flag = new URLSearchParams(env.search).get('tabIdentity');
  if (flag && env.session) safe(() => env.session!.setItem(TAB_FLAG, '1'), undefined);
  const tab = env.session ? safe(() => env.session!.getItem(TAB_FLAG) === '1', false) : false;
  return tab ? env.session : env.local;
}

export function loadToken(env: TokenEnv, uri: string, db: string): string | undefined {
  const store = tokenStore(env);
  if (!store) return undefined;
  if (new URLSearchParams(env.search).get('tabIdentity') === 'new') {
    safe(() => store.removeItem(tokenKey(uri, db)), undefined);
    return undefined;
  }
  const t = safe(() => store.getItem(tokenKey(uri, db)), null);
  return t || undefined;
}

export function saveToken(env: TokenEnv, uri: string, db: string, token: string): void {
  const store = tokenStore(env);
  if (store && token) safe(() => store.setItem(tokenKey(uri, db), token), undefined);
}

export function clearToken(env: TokenEnv, uri: string, db: string): void {
  const store = tokenStore(env);
  if (store) safe(() => store.removeItem(tokenKey(uri, db)), undefined);
}
