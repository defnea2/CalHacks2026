// TEMPORARY latency instrumentation (branch agent/voice-tutor-latency only): one
// `LAT {...}` line per event on stdout, `now` = Date.now() with sub-ms precision.
import { performance } from 'node:perf_hooks';

const origin = Date.now() - performance.now();
export function lat(ev: string, data: Record<string, unknown> = {}): void {
  const out: Record<string, unknown> = { ev, now: Math.round((origin + performance.now()) * 1000) / 1000 };
  for (const [k, v] of Object.entries(data)) out[k] = typeof v === 'bigint' ? Number(v) : v;
  process.stdout.write(`LAT ${JSON.stringify(out)}\n`);
}
