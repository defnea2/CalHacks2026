# Classroom: teachers, class sessions, simulation, teacher dashboard

Owner: `night/classroom-core` (contract: `docs/CONTRACT-night.md` section 2). Everything runs in the
SpacetimeDB module; the LLM worker only produces the tutor replies (text mode for simulated
students). Code: `spacetimedb/src/schema_classroom.ts` (tables), `spacetimedb/src/classroom.ts`
(logic), `spacetimedb/src/classroom_context.ts` (teacher block in `buildContext`),
`shared/src/classroom/simStudents.ts` (20 seed students), `shared/src/classroom/clusters.ts`
(cluster validation + repair). Tests: `spacetimedb/test/classroom.test.ts`, `shared/test/classroom.test.ts`.

## Tables (all public unless noted)

| Table | Columns | Notes |
|---|---|---|
| `teacher` | `id u64 pk autoInc, name, createdAt` | `createTeacher(name)` |
| `learner` (+2 cols) | `isSimulated bool`, `simRank u32` | simulation users have rank 1..20 |
| `presence` | `learnerId pk, status, connectionId (hex), updatedAt` | `offline \| waiting \| in_session` |
| `class_session` | `id, teacherId, goals, content, delivery, documentName, documentMime, documentText, active, simulation, simulatedCount, startedAt, endedAt?` | one active per teacher |
| `class_document` (private) | `classSessionId pk, data bytes` | image payload only; Markdown is `documentText` |
| `session` (+1 col) | `classSessionId u64` (0 = ad-hoc) | linked sessions; `voice=false` for simulated ones |
| `sim_profile` | `rank pk, name, age, grade, style, persona, misconceptions (JSON string[]), memory (JSON notes)` | read-only seed, loaded in `init`/connect |
| `class_summary` | `classSessionId pk, summary, updatedAt, version` | version +1 per refresh |
| `student_cluster` | `id, classSessionId idx, position, name, description, learnerIds (JSON string[])` | replaced atomically per refresh |
| `dashboard_state` | `classSessionId pk, impersonatingLearnerId (0 none), lastRunAt?, nextDueAt, running, runStartedAt?, lastError` | `lastError` '' = ok |
| `sim_turn_job`, `sim_running`, `dashboard_job` (private) | scheduling | |

The UI reads each student's chat in/out from `turn` (`role`, `text`, `source` = `voice\|text\|sim`)
of the student's active session (`session.classSessionId = class id`), and the visualization from
the usual per-session tables (`board_item`, `canvas_state`, `beat`, `lesson_state`).

## Reducers / procedures

```ts
createTeacher(name: string)
setPresence(learnerId: u64, status: 'offline' | 'waiting' | 'in_session')   // remembers the caller's connection
startClassSession(teacherId: u64, goals: string, content: string, delivery: string,
                  documentName: string, documentMime: string, documentText: string,
                  documentData: bytes, simulatedCount: u32)
endClassSession(classSessionId: u64)
setImpersonation(classSessionId: u64, learnerId: u64)                       // 0 = stop observing
procedure refreshDashboard(classSessionId: u64) -> string                    // JSON {ok, skipped?, error?, repaired?, repairs?, clusters?}
// scheduled (internal): dashboardTick (dashboard_job), simStudentTurn (sim_turn_job)
```

- **Presence.** The student client calls `setPresence(id, 'waiting')` on "wait for teacher" and
  `'in_session'` when it starts its own session. `clientDisconnected` sets every learner whose
  presence was written from that connection to `offline` (simulated learners excepted). Online =
  `waiting` or `in_session`.
- **startClassSession.** Ends the teacher's previous active class session, inserts the class
  session (+ `class_document` for an image), then moves EVERY online real student (`waiting` or
  `in_session`, ad-hoc or another class) into a new session linked to it; their previous session
  ends (normal `endSession`: final memory extraction + summary). The student keeps voice/text mode.
  `taskText` of a linked session = teacher's `content` (or `goals`), so the authored opening names it.
  Documents: `''`, `text/markdown`/`text/plain`/`text/x-markdown` (in `documentText`, max 50 000
  chars) or `image/jpeg|png|webp|gif` (in `documentData`, max 1 MB). Then the simulation (below)
  and the dashboard (first refresh after `DASHBOARD_INTERVAL_S`).
- **Clients of linked sessions** call `startConversation(sessionId)` as for any session (voice needs
  the click for the AudioContext). Simulated sessions do it in the module.
- **endClassSession.** Ends all linked sessions; real students go back to `waiting`, simulated ones
  `offline`; dashboard jobs are removed.
- **Teacher instructions in the tutor context.** `buildContext` appends for linked sessions:
  teacher name, learning goals, content to cover, delivery instructions (marked binding), and the
  Markdown document (first 12 000 chars). An image document reaches the worker's first call through
  `getSessionImage` (falls back to the class document when the session has no own photo; `hasImage`
  is set on linked sessions), exactly like a task photo.

## Simulation

- `startClassSession(..., simulatedCount = n)` (n ≤ 20): simulation users with rank > n leave
  (session ended, `offline`). Users 1..n, in seed order, are reset: the old learner row and
  everything hanging off it is deleted (sessions, turns, phrases, sentences, board items +
  answers, metrics, jobs, canvas/beat/lesson state, memory notes + evidence, concept states,
  session summaries, presence) and the learner is recreated from `sim_profile` with its 3-6 seed
  memory notes. Each gets a linked text-mode session (`voice=false`), presence `in_session`, and
  `startConversation`: the tutor speaks first (worker opening), the simulated student answers.
- **Turn loop.** Whenever a simulated session's `turnState` returns to `listening` (a hook on
  `updateSession`: the text-mode reading delay of the tutor's last sentence ended) and no student
  turn is pending, a `sim_turn_job` is scheduled 2-5 s later. `simStudentTurn` calls Haiku 5.5
  (`callAnthropicJson`, effort low, max 2000 tokens, schema `{message}`) with the persona, age,
  style, typical misconceptions, a behaviour for this turn (30 % typical mistake, 15 % question,
  10 % hesitant, 45 % honest best), the class topic, board, canvas, lesson state and the last 14
  turns, then appends the message through `submitTextTurn` with `source 'sim'` (emoji/markdown
  stripped, max 300 chars). The worker answers it like any typed turn.
- **Caps.** `SIM_MAX_TURNS` (env, default 8) student turns per session per run. At most 4
  student-LLM calls in flight (`sim_running` markers, stale after 90 s); a job that finds all slots
  busy re-checks after ~1.5 s (max 40 times). Procedure slots on this machine are ~10 in total, and
  STT/TTS/extraction/dashboard need some too. A stale job (the session moved on: `turnCount`
  changed, tutor busy, class ended) does nothing. HTTP/parse failures retry after 5 s twice.

## Dashboard

- **Cadence.** One `dashboard_job` per active class session, due at `dashboard_state.nextDueAt`
  (`DASHBOARD_INTERVAL_S`, default 30 s after the previous run finished). `refreshDashboard`
  (refresh button) runs at once and moves the next run to +30 s. A run that fails keeps the old
  rows, sets `lastError` and retries in 10 s. `running` + `runStartedAt` prevent overlapping runs
  (stale after 120 s).
- **Impersonation.** While `impersonatingLearnerId != 0` neither the scheduled run nor the button
  refreshes (button returns `{"ok":false,"skipped":"impersonating"}`); the scheduled job is consumed
  without rescheduling. `setImpersonation(id, 0)`: if `nextDueAt` has passed, the refresh runs now;
  otherwise at `nextDueAt`.
- **LLM call.** ONE Haiku 5.5 call per refresh (effort low, max 6000 tokens) with the teacher's
  goals/content/delivery and, per active student: name, age, grade, style, phase, topic, tutor
  state, lesson state, board, canvas, up to 8 memory notes, last 16 turns. Output schema:
  `{classSummary, clusters: [{name, description, learnerIds}]}`. The prompt states the size rule and
  the allowed size combinations for the class (e.g. 6 → `4+2 or 2+2+2`).
- **Validation + repair (in code).** Every active student in exactly one cluster; every cluster
  exactly 2 or 4 students. Exceptions forced by arithmetic: an odd class has exactly one cluster
  of 3 (the only 3); a class of one student has one cluster of 1. Violations are repaired
  deterministically (`repairClusters`): unknown ids dropped, duplicates keep their first cluster,
  2s/4s kept, larger clusters cut into 4s (+2 or the one 3), extra 3s give one student up,
  leftovers sorted by similarity (phase, topic, LLM cluster) and paired; an odd leftover joins the
  most similar pair. Merged groups carry both LLM names (`A · B`). Summary + clusters + state are
  written in one transaction.

## Run it (own DB)

```sh
SPACETIME_DB=night-class STT_BASE_URL=https://api.cartesia.ai CARTESIA_STT_MODEL=ink-whisper node scripts/publish.mjs --clear
SPACETIME_DB=night-class pnpm --filter worker start
# from a directory without spacetime.json (or pass --no-config):
spacetime call --no-config --server local night-class create_teacher '"Ms. Park"'
spacetime call --no-config --server local night-class start_class_session 1 '"goals"' '"content"' '"delivery"' '""' '""' '""' '[]' 6
spacetime call --no-config --server local night-class set_impersonation 1 3     # observe learner 3
spacetime call --no-config --server local night-class set_impersonation 1 0     # stop
spacetime call --no-config --server local night-class refresh_dashboard 1
spacetime call --no-config --server local night-class end_class_session 1
spacetime logs --no-config --server local night-class | grep -E 'simStudentTurn|refreshDashboard'
```

Each LLM call logs model, latency and token usage (`simStudentTurn s<id> <name> [behaviour] ...`,
`refreshDashboard c<id> <n> students ... clusters 4+2`).

## Measured (2026-10-25, local server, real Haiku 5.5, DB `night-class`)

- Runs: n=6 (fractions, no document) and n=8 (decimals, Markdown document; resets users 1..6 live).
  Both: every session reached the cap of 8 simulated turns + 9 tutor replies in ~2 min
  (n=8: 64 student turns, 09:16:43 → 09:18:44). No module warnings; no rejected turns.
- Student LLM (112 calls): median 1.5 s (0.8-2.8 s), ~1.4k in / 65 out tokens, ≈ $0.00018 per
  turn. Behaviour mix seen: correct 47, mistake 44, question 11, unsure 10.
- Dashboard (11 calls): 6 students 2.7-4.4 s (5-10k in / ~400 out); 8 students 6.6-10 s
  (5-12k in / 0.4-1.9k out, thinking at effort low); ≈ $0.0015 per refresh. Cadence ~33-38 s
  (30 s after the previous run finished + LLM time). n=6 first two answers had singletons (repaired
  4+2); after the prompt lists the allowed combinations, all n=8 answers were valid without repair
  (4+2+2, 4+4, 2+2+4). Impersonation: no refresh while observing (button returned
  `skipped: impersonating`); stop when overdue → refresh finished 2.9 s later.
- Memory extraction during the runs: 28 windows for 14 sessions (2 each), no duplicates.
