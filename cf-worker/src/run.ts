// One dispatch = one LessonRun (worker/src/lesson.ts, unchanged) over the HTTP transport.
// Same planner prompt, parser, repair round, recap and fallback as the Node worker; what differs:
// - the planner request, photos and topic prefetch come with the dispatch body (no round trip);
// - barge-in is seen at the next reducer call ("not current") and aborts the stream (no repair);
// - a hard cap: the whole lesson must finish inside Cloudflare's 30 s waitUntil window, so the
//   total deadline is CAP_TOTAL_MS (then the recap path closes it) and at HARD_STOP_MS the run is
//   cut off (the module's dispatchWatch closes whatever is left).
import { libraryIndex, OPENING_TURN_IDX, pack, type LlmProvider } from '@tutor/shared';
import { LessonRun, type LessonDeadlines } from '../../worker/src/lesson';
import { prefetchTopic } from '../../worker/src/topic';
import { HttpTransport } from './http_transport';
import type { DispatchBody } from './types';

export const CAP_TOTAL_MS = 24_000;
export const HARD_STOP_MS = 28_000;
/** The lesson opening waits this long for an LLM topic classification (its lead-in plays meanwhile). */
export const OPENING_TOPIC_WAIT_MS = 3500;

export interface RunDeps {
  url: string;
  db: string;
  token: string;
  llm: LlmProvider;
  /** LLM for the topic classifier (default: llm). */
  topicLlm?: LlmProvider;
  library?: boolean;
  fetch?: typeof fetch;
  log?: (m: string) => void;
  now?: () => number;
  deadlines?: Partial<LessonDeadlines>;
  hardStopMs?: number;
}

export interface RunResult {
  state: string;
  beats: number;
  stale: boolean;
  firstTokenMs: number | null;
  firstBeatMs: number | null;
  totalMs: number;
  rtts: HttpTransport['rtts'];
}

let cachedIndex: string | undefined;
const libIndex = () => (cachedIndex ??= libraryIndex(pack));

export async function runDispatch(body: DispatchBody, deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (m => console.log(m));
  const t0 = now();
  let run: LessonRun | undefined;
  const transport = new HttpTransport({
    url: deps.url,
    db: deps.db,
    token: deps.token,
    body,
    fetch: deps.fetch,
    now,
    onStale: msg => {
      log(`[d${body.dispatchId} u${body.utteranceId}] stale: ${msg.slice(0, 160)}; aborting the stream`);
      run?.interrupt('not current');
    },
  });
  const sessionId = BigInt(body.sessionId);
  const opening = body.kind === 'opening';
  // Topic prefetch (first dispatch of a session without a concept): LLM classification + setTopic.
  const t = body.topic;
  const topicReady =
    t && !t.ok && (t.text || t.hasImage)
      ? prefetchTopic({ transport, llm: deps.topicLlm ?? deps.llm, pack, log, now }, sessionId).then(r => log(`[d${body.dispatchId}] topic ${r.category || '-'}/${r.concept || '-'} (${r.source}, ${r.ms} ms)`))
      : undefined;
  run = new LessonRun(
    {
      transport,
      llm: deps.llm,
      log,
      now,
      deadlines: { totalMs: CAP_TOTAL_MS, ...deps.deadlines },
      libraryIndex: deps.library === false ? undefined : libIndex(),
    },
    {
      sessionId,
      turnIdx: opening ? OPENING_TURN_IDX : body.turnIdx,
      opening,
      transcript: body.transcript,
      utteranceId: BigInt(body.utteranceId),
      wantImage: !!body.image,
      turnPhoto: !!body.turnImage,
      held: false,
      prelude: body.prelude.length ? body.prelude : undefined,
      topicReady,
      topicWaitMs: opening ? OPENING_TOPIC_WAIT_MS : 0,
    }
  );
  const r = run;
  let stop: ReturnType<typeof setTimeout> | undefined;
  const hardStop = new Promise<void>(resolve => {
    stop = setTimeout(() => {
      if (r.open) {
        log(`[d${body.dispatchId} u${body.utteranceId}] hard stop after ${deps.hardStopMs ?? HARD_STOP_MS} ms`);
        r.interrupt('hard stop');
      }
      resolve();
    }, deps.hardStopMs ?? HARD_STOP_MS);
  });
  try {
    await Promise.race([r.done, hardStop]);
    await Promise.race([topicReady ?? Promise.resolve(), hardStop]);
  } finally {
    clearTimeout(stop);
  }
  const res: RunResult = {
    state: r.state,
    beats: r.stats.beats,
    stale: transport.isStale,
    firstTokenMs: r.stats.firstTokenMs,
    firstBeatMs: r.stats.firstBeatMs,
    totalMs: now() - t0,
    rtts: transport.rtts,
  };
  const rtt = (n: string) => transport.rtts.filter(x => x.name === n).map(x => x.ms);
  log(
    `[d${body.dispatchId} u${body.utteranceId} ${body.kind} t${body.turnIdx}] ${res.state}${res.stale ? ' (stale)' : ''}: ${res.beats} beats, ` +
      `first token ${res.firstTokenMs ?? '-'} ms, first beat ${res.firstBeatMs ?? '-'} ms, total ${res.totalMs} ms, ` +
      `rtt addBeat ${JSON.stringify(rtt('addBeat'))} beginUtterance ${JSON.stringify(rtt(opening ? 'beginOpening' : 'beginUtterance'))}`
  );
  return res;
}
