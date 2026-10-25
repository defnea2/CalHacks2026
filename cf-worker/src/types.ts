// The dispatch body the SpacetimeDB module POSTs (mirror of spacetimedb/src/dispatch.ts DispatchBody).
export interface DispatchBody {
  v: 1;
  dispatchId: string;
  attempt: number;
  kind: 'turn' | 'opening';
  /** u64 values travel as decimal strings. */
  sessionId: string;
  turnIdx: number;
  utteranceId: string;
  transcript: string;
  /** Raw buildLessonRequest result: JSON {ok, request, topic, library, say?, sayOnly?}. */
  built: string;
  image: string;
  turnImage: string;
  topic: { ok: boolean; category: string; concept: string; source: string; text: string; hasImage: boolean } | null;
  prelude: string[];
  builtAtMs: number;
}

export interface Env {
  STDB_URL: string;
  STDB_DB: string;
  STDB_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  CF_DISPATCH_SECRET: string;
  ANTHROPIC_MODEL?: string;
  LESSON_EFFORT?: string;
  LESSON_LIBRARY?: string;
}

/** The part of Cloudflare's ExecutionContext used here. */
export interface WaitCtx {
  waitUntil(p: Promise<unknown>): void;
}

export function isDispatchBody(v: unknown): v is DispatchBody {
  const b = v as Partial<DispatchBody> | null;
  return (
    !!b &&
    b.v === 1 &&
    (b.kind === 'turn' || b.kind === 'opening') &&
    typeof b.sessionId === 'string' &&
    /^\d+$/.test(b.sessionId) &&
    typeof b.utteranceId === 'string' &&
    /^[1-9]\d*$/.test(b.utteranceId) &&
    typeof b.turnIdx === 'number' &&
    typeof b.built === 'string' &&
    Array.isArray(b.prelude)
  );
}
