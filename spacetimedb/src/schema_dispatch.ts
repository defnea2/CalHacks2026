// Tables of the Cloudflare dispatch path (docs/CLOUD_PLAN.md Part B, module env LLM_DISPATCH=cloudflare).
// With LLM_DISPATCH=worker (default) no row is ever written. All private.
import { table, t } from 'spacetimedb/server';

/** One LLM step the module asked the Cloudflare Worker for (a student turn or the opening). */
export const llmDispatch = table(
  { name: 'llm_dispatch' },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    /** turn | opening */
    kind: t.string(),
    /** Student turn answered (OPENING_TURN_IDX for the opening). */
    turnIdx: t.u32(),
    /** Allocated by the module: a duplicate delivery is rejected by beginUtterance/beginOpening. */
    utteranceId: t.u64().index('btree'),
    /** pending -> sent (202) -> running (utterance began) -> done | failed | superseded */
    status: t.string(),
    /** 0 = first try, 1 = the one retry (new utteranceId). */
    attempt: t.u32(),
    /** The session photo went out with this dispatch (sent once per session, like the Node worker). */
    withImage: t.bool(),
    createdAt: t.timestamp(),
    sentAt: t.option(t.timestamp()),
    /** Cloudflare's 202 arrived. */
    acceptedAt: t.option(t.timestamp()),
    /** First reply sentence (or beat) of the utterance. */
    firstBeatAt: t.option(t.timestamp()),
    lastBeatAt: t.option(t.timestamp()),
    error: t.string(),
  }
);

/** Scheduled (due now): procedure dispatchTurn POSTs the dispatch to the Cloudflare Worker. */
export const dispatchJob = table(
  { name: 'dispatch_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    dispatchId: t.u64(),
  }
);

/** Scheduled liveness check of one dispatch (reducer dispatchWatch): retry once, then the fallback line. */
export const dispatchWatchJob = table(
  { name: 'dispatch_watch_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    dispatchId: t.u64(),
  }
);
