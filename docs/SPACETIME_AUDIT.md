# SpacetimeDB 2.13 usage audit

An audit of how Fibonacci uses SpacetimeDB 2.13 (module `spacetimedb/`, client `client/`, worker
`worker/`), done on the night before judging. It ranks findings, lists where the docs had drifted
from the code, separates what was fixed now from what waits until after the hackathon, and closes
with the honest story for judges.

## Ranked findings

| # | Severity | Finding | Where | Status |
| --- | --- | --- | --- | --- |
| 1 | High | **No `ctx.sender` authorization on client reducers.** Any connected client can call session and teacher reducers for any id (`endSession`, `startClassSession`, `setImpersonation`, ...); `setPresence` lets a second tab take over a learner's presence. Only agent reducers (`requireAgent`) and turn photos (`requireOwner`) check the caller. By spec there are test users only, but it is the biggest gap. | `spacetimedb/src/index.ts`, `classroom.ts`, `sessions.ts` | After hackathon (real identities: `night/identity`) |
| 2 | High | **A new identity per page load.** The client never passes a token, so a reload gets a new identity, and `requireOwner` then rejects `attachImage` / `removePendingImage` in a reloaded ad-hoc `?session=` tab. | `client/src/stdb/connection.ts`, `spacetimedb/src/turn_photo.ts` | Handed to `night/identity` (owns connection.ts and ownership checks) |
| 3 | Medium | **Cancelled TTS kept calling Cartesia.** Barge-in, supersede and `endSession` marked sentences `dropped` but left their `tts_job` rows, so `synthesizeSentence` still made the HTTP call and held a procedure slot (the commit check discarded the audio). | `voice_out.ts` `beginUtterance` / `interrupt`, `sessions.ts` `closeSession` | **Fixed now**: `cancelTtsJobs` (`ctx.ts`) deletes the reply's (or session's) pending jobs |
| 4 | Medium | **Table-wide worker subscriptions.** The worker subscribes to all of `turn`, `phrase`, `reply_sentence`, `board_item`, `learner`; any row, including one of an ended session, created a `SessionAgent` that was never removed. | `worker/src/stdb.ts` `SUBSCRIPTIONS`, `worker/src/agent.ts` | **Guard fixed now** (rows of ended or not-active sessions are ignored; the agent is dropped when its session ends). **Fixed** (`night/stdb-hardening`): JOIN subscriptions on `session.active` (initial set 1456 → 42 rows on a DB with 36 sessions of history); teacher screens narrowed too |
| 5 | Medium | **No retention.** Transcripts, metrics, lesson records, summaries are kept until the database is cleared. | all tables | **Partly fixed** (`night/stdb-hardening`): scheduled `retention_job` deletes photo bytes 30 min after the session ended (`RETENTION_IMAGE_MIN`), optional `RETENTION_DAYS` prunes lesson JSON; transcripts, metrics and memory are kept on purpose (ARCHITECTURE §2 Retention) |
| 6 | Medium | **`deleteSessionData` misses tables**: `lesson_record`, `lesson_plan`, `text_playback`, `text_play_job`, `turn_image`, `session_owner` survive a sim reset. | `classroom.ts` `deleteSessionData` | **Fixed** (`night/stdb-hardening`): every session-keyed table via typed index deletes; generic test |
| 7 | Low | **Missing indexes** on filtered columns: `session.classSessionId`, `learner.simRank`, the `sessionId` columns of job tables, `turnMetrics.utteranceId`. Scans are fine at demo scale. | `schema.ts`, `schema_classroom.ts` | **Fixed** (`night/stdb-hardening`): additive indexes, scans replaced (ARCHITECTURE §2 Indexes) |
| 8 | Low | **Stringly typed data**: JSON in string columns, string enums (`status`, `turnState`, `phase`), procedures returning JSON strings instead of typed product values. | `schema.ts`, `index.ts` procedures | **Partly fixed** (`night/stdb-hardening`): `refreshDashboard` returns a typed product, `student_cluster.members u64[]`; `learnerInsights` and agent procedures stay JSON on purpose, error convention documented (ARCHITECTURE §3) |
| 9 | Low | **TTS retry inside the same procedure call** (one immediate retry), while STT and memory retry with new scheduled rows. | `voice_out.ts` `synthesizeSentence` | **Fixed** (`night/stdb-hardening`): retry is a new `tts_job` row (`attempt`), cancellable by barge-in |
| 10 | Low | **`onConnect` hashes the lesson pack on every connect** to decide whether to reload the library (cheap, but per connection). | `index.ts` `onConnect`, `library.ts` | **Fixed** (`night/stdb-hardening`): hash and profile rows computed once per module instance |
| 11 | Low | **`summary_job` has no dedupe and no backup**: two end paths can schedule two summaries; a failed summary is not rescheduled. | `memory.ts` | **Fixed** (`night/stdb-hardening`): one `summary_job` per session; extraction backup job (watchdog) for a crashed run |
| 12 | Info | **`requestTutor` / `tutor_request` has no UI caller.** The reducer and the worker's `tutorRequests.ts` exist; no screen inserts a request. | `pipeline.ts`, `worker/src/tutorRequests.ts` | Documented; the worker no longer subscribes, reducer marked unused (`night/stdb-hardening`) |

| 13 | High | **Scheduled reducers and procedures are client-callable in 2.13.** Verified with the CLI on a local 2.13 server: `spacetime call <db> dashboard_tick {...}` runs the procedure, and `finish_text_sentence` reaches its body (rejected only by its own `scheduler only` check). The scheduled procedures (`synthesize_sentence`, `transcribe_phrase`, `extract_memory`, `summarize_session`, `sim_student_turn`, `dashboard_tick`) have no such check, so any client can trigger provider calls with arbitrary job rows. | `index.ts` scheduled exports | Open: caller checks belong to `night/identity`. The scheduled reducers (`finishTextSentence`, `runRetention`) check `ctx.sender == ctx.identity` |

## Fixed in `night/stdb-hardening`

Items 4–12 above, each a commit with tests: indexes and index lookups (the test datastore cannot
decode a point-terminated prefix scan, so utterance lookups use single-column indexes), complete
`deleteSessionData`, retention sweep, JOIN-filtered worker subscriptions and narrower teacher
screens, TTS retry rows, extraction watchdog + summary dedupe, typed `refreshDashboard` + error
convention, small fixes (typed cluster members, cached pack hash, `submitGapAnswer` limits,
`tutor_request` unsubscribed), shared `useRows` snapshots in the client. Every schema change is
additive; `spacetime publish` without `--clear` onto a database with history applied each one
(new indexes, `retention_job`, `tts_job.attempt`, `board_item.attempts`, `student_cluster.members`).
Adding a column disconnects clients once (the worker and the client reconnect).
Not changed: `text_playback.endsAtMicros` / `extraction_cursor.runningSinceMicros` stay u64 micros
(a column type change is not an automatic migration).

## Drift between docs and code

- `docs/ARCHITECTURE.md` §3 was missing exports: `interruptUtterance`, `prefetchTopic`,
  `seedMemory`, `startClassSessionWith`, `resetSimulatedStudents`. Added. (`attachImage`,
  `removePendingImage`, `getTurnImage`, `learnerInsights` were already there.)
- §11 said every view, the worker included, subscribes to narrow `WHERE session_id = X` queries.
  The worker's subscriptions are table-wide with a guard. Corrected.
- §11 said "retries are new rows" and "cancellation is a delete or a status check". TTS retried in
  the same call, and cancellation was the status check only. Corrected (cancellation now deletes the
  jobs; the TTS retry is described as it is).
- §11 "One identity model" read as if clients were authorized. Now it says client reducers do not
  check `ctx.sender`.
- Stale line references in `README.md` and `docs/JUDGING.md` (the code had moved since they were
  written), recomputed after this branch's edits: `audio_in` `schema.ts:102-114`, `audio_out`
  `schema.ts:202-216`, `turn_metrics` `schema.ts:266-287`, audio deleted at `voice_in.ts:237` and
  `sessions.ts:91`, STT procedure `voice_in.ts:253`, too-short phrase `voice_in.ts:263`, TTS
  procedure `voice_out.ts:122`, barge-in `voice_out.ts:213-257`, `registerAgent` `index.ts:189-195`,
  agent procedures `index.ts:304-359`, worker homework check `worker/src/lesson.ts:520`, debug panel
  `session.tsx:178-240`.
- `requestTutor` was documented as a feature; it has no UI caller. Noted in §3.

## Fixed now vs after the hackathon

**Fixed now (branch `night/stdb-consistency`; small, tested):**

- Pending `tts_job` rows are deleted on barge-in (`interrupt`, `interruptUtterance`), on supersede
  (`beginUtterance` of a newer reply) and on `endSession`. A job already running is unaffected; its
  commit transaction still re-checks `pending`. Tests: `spacetimedb/test/voice_out.test.ts`
  "cancelled replies delete their pending tts_job rows".
- Worker guard: `turn` / `phrase` / `reply_sentence` rows of an ended session, or of a session not in
  the worker's active-session cache, no longer create a `SessionAgent`; the agent is dropped when its
  session ends; a reused id (cleared database) is served again. Tests:
  `worker/test/staleSession.test.ts` "ended or unknown sessions".
- Docs: §3 exports, §11 claims, stale line references, this audit.

**After the hackathon:**

- Real identities and `ctx.sender` checks on session, teacher and presence reducers, and on the
  client-callable scheduled procedures (finding 13) (`night/identity`).
- Retention of transcripts, metrics and summaries (photos and optional lesson JSON expire already).
- Enums instead of strings where the SDK allows; typed `learnerInsights` once clients can be
  redeployed together with the module.
(Done in `night/stdb-hardening`: join-filtered subscriptions, complete `deleteSessionData`, indexes,
TTS retry rows, extraction watchdog, summary dedupe, cached pack hash, typed `refreshDashboard`.)

## Story for judges

**Strongest:**

1. **The LLM proposes, the module decides.** `beginLesson` validates the lesson meta (team schema,
   phase policy, no repeated check, homework not handed out) and `addBeat` compiles every moment
   against the live `canvas_state` in the reducer transaction (`spacetimedb/src/pipeline.ts`). A
   rejection is a `SenderError` the worker turns into a repair round; an interrupted presentation
   rolls the canvas back to the last beat the learner saw (`onUtteranceEnd`).
2. **Scheduled procedures for every side effect.** STT, TTS, memory extraction, summaries, simulated
   students and the dashboard are rows with `scheduleAt` handled by procedures. The HTTP call runs
   outside any transaction; the commit transaction re-checks state (a sentence dropped mid-call gets
   no audio). Cancellation deletes the job rows.
3. **Event tables for streams, private tables for raw data.** `audio_out`, `playback_flush` and
   `speech_activity` are event rows (delivered at commit, never stored). Mic audio goes up as binary
   reducer args into the private `audio_in` and is deleted right after transcription.
4. **Observe = the same subscription.** The teacher's observe frame renders the student's view on the
   same `sessionQueries` (`client/src/stdb/useSessionData.ts`); no extra backend.
5. **The class dashboard is a scheduled job** in the module (`dashboard_job`, skipped while observing
   and run when overdue), with a stale-slot watchdog for simulated students (`sim_running`).
6. **Additive migrations**: schema changes only add tables and columns, so the module republishes
   without clearing data.

**Weakest (say it before being asked):**

1. No `ctx.sender` authorization on client reducers: any client can call session and teacher
   reducers, and `setPresence` can take over a learner's presence. Test users only, by spec.
2. Scheduled reducers and procedures are client-callable in 2.13; only the scheduled reducers check
   the scheduler identity (finding 13).
3. Transcripts, metrics and memory have no expiry (photos expire after 30 min); JSON in string
   columns, string enums, `learnerInsights` returns a JSON string.
