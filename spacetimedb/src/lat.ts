// TEMPORARY latency instrumentation (branch agent/voice-tutor-latency only).
// One `LAT {...}` log line per event: `now` = Date.now() (wall ms) when the line is written,
// `ts` = the transaction timestamp (ms) when a ctx is given. Read with `spacetime logs`.
/** Tags of the procedure running in this module instance (one call at a time per instance). */
let tag: Record<string, unknown> = {};
export function latTag(t: Record<string, unknown>): void {
  tag = t;
}

export function lat(ev: string, data: Record<string, unknown> = {}, ctxTs?: { microsSinceUnixEpoch: bigint }): void {
  const out: Record<string, unknown> = { ev, now: Date.now(), ...(data.s === undefined ? tag : {}) };
  if (ctxTs) out.ts = Number(ctxTs.microsSinceUnixEpoch) / 1000;
  for (const [k, v] of Object.entries(data)) out[k] = typeof v === 'bigint' ? Number(v) : v;
  console.info(`LAT ${JSON.stringify(out)}`);
}
