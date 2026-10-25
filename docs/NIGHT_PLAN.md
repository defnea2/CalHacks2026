# Night plan (2026-10-25) — voice math tutor, classroom + team integration

Owner: lead session. Spec of the original build: `/Users/leanderneubronner/.claude/plans/implement-this-first-check-tidy-reddy.md` + `CalHacks.pdf` in the repo. Presentation to judges in the morning.

## User decisions (binding)
- End result lands on `main`, but built from feature branches `night/*`, each merged `--no-ff` so every feature can be reverted with `git revert -m 1 <merge-sha>`. Morning report: `docs/NIGHT_REPORT.md` (what, why, branch, merge sha, revert command, open issues).
- Base: team branch `origin/integration/abdul-voice` (Can, Abdul) + our `agent/voice-tutor`. Never rewrite/force-push team branches; never push to `integration/abdul-voice` itself.
- UI: the TEAM's design is used (our client UI is largely boilerplate). Visualization takes most of the screen; small transcript.
- No functionality outside the client and SpacetimeDB, except the granted exceptions: the LLM worker (streaming) and the STT proxy. => The team's Vite server endpoint (`src/server/*`, `/api/teaching/plan`, `/status`, `/shear-feedback`) moves into the worker; the client must build to purely static files.
- Do NOT migrate SpacetimeDB to Maincloud (user does that in the morning). Local server on 127.0.0.1:3000 only.
- LLM: Claude Haiku 5.5 (`claude-haiku-5-5`) via Anthropic. Teacher-dashboard LLM parts: same model, NON-streaming, called from SpacetimeDB procedures (raw HTTP to api.anthropic.com — the SDK cannot run in procedures).
- Subagents: Opus (not Fable), worktrees, own branches, commit/push often.

## Previously recommended, now adopted (user did not object; keep revertable as own branch)
- `set_topic` becomes an action with optional `phase` (idempotent); topic prefetch from task text/photo before the first reply; compact library index in the system prompt (full material for the set topic via context).
- Memory extraction + session summary on Haiku 5.5 (raw HTTP from the module), OpenRouter as config fallback.
- VAD robustness: soft speech onsets after short pauses (misfire during an open turn resets the turn-end wait; see E2E um-pauses analysis).

## Team tasks to check/complete
- Can: rigid lesson structure demonstrable in ~2 minutes; agent takes ownership in the initial explanation; worst case it shows a visualized explanation, formalization and a task within the time. Visualizations keyframe-based on point (timed to speech).
- Leander: overview of multiple sessions; zoom in/observe one student; big-picture view; AI-based clusters of students + general info. (Merges with the classroom teacher dashboard below.)
- Abdul: page design: entry page → select/create user → learn by yourself (situation + photo) or wait for teacher → visualize speech, processing and return (AI bubble, something happens while thinking); visualization most of the screen; small transcript. Plus: an avatar for the agent.

## Classroom feature (user spec, verbatim essentials)
- Users are students or teachers, freely created/chosen, no auth. Students choose: own ad-hoc session, or wait for a teacher.
- Teacher: executive instructions (learning goals, content to cover) + delivery instructions (how to teach) + optional attached document (image or Markdown; more formats optional). Starting a class session puts EVERY online student (waiting or in session) into a live session with those instructions. No classes.
- Simulation: configurable number n of students; no STT/TTS; student input written by an LLM. Simulation students are real users with individual memories in the DB; 20 realistic seed records, the first n are used in order (not random); reset for each new simulation run.
- Teacher dashboard (style of the rest, minimalist, nothing unneeded):
  - Top: summary of the class's learning state; updated every 30 s or on a refresh button.
  - Below: active students clustered into categories by similarity (common phase, similar problem). Short category names; each category has a short LLM summary under it. Each category has EXACTLY two or four students. Four students per row => one or two categories per row.
  - Student interaction (chat in/out) shown greyscale/greyed out. Hover → "Observe" button → view where the teacher watches the student learn (transcript + visualization), framed with controls: previous/next student, stop impersonation.
  - Summaries are not updated while impersonating; when impersonation stops and the 30 s timer is overdue, update immediately.
  - LLM: Haiku 5.5 non-streaming from SpacetimeDB procedures; whole student context passed in.
  - Test the simulation, summaries and impersonation thoroughly.

## Team integration design (approved: "A, SpacetimeDB-idiomatic")
The team's contribution is mainly methodology + UI; integrate it into the CalHacks.pdf architecture, change their code to be idiomatic, keep UI as similar as possible.
- Pure logic (compact lesson compile, `validateModelStep`, schema contract, canvas compiler against the current canvas) → `shared/` (pure TS), used by worker (early) and module (authoritative).
- Worker: the team's streaming planner (`src/server/streamingLesson.ts`, `anthropicModel.ts`: Claude stream, incremental JSON parse, release a moment when the next `,` proves completeness, repair round, stall timeout) becomes a reply mode; instead of SSE it calls reducers. Remove `/api/teaching/*` and the Vite plugin; client builds static.
- Triggers: learner input is a `turn` (voice via STT, or `submitTextTurn(sessionId, text)`; buttons like "Show another way"/"Smaller step"/"Continue" = turn with an `intent`); canvas interactions → `submitInteraction(sessionId, kind, payload)` → `learner_event` rows validated against `canvas_state`, recorded as evidence.
- Each complete moment → `addBeat(sessionId, utteranceId, idx, visualJson, narration)`: module compiles/validates against `canvas_state`; valid → `beat` row (visual keyframe) + `reply_sentence` (narration) + `tts_job` in voice mode; `canvas_state` advances. Invalid → reducer rejects → worker repair round / recap beat per the team's contract.
- `/status` → public `agent_status` heartbeat row. `/shear-feedback` → request row → worker → result row.
- `TeachingSession` authoritative state (phase, awaiting_response, evidence, lesson notes) → module tables; client keeps only presentation state (pause/next/replay). Keyframes fire on the spoken word in voice mode (markers/sentence reveal); text mode plays beats with the team's local playback controls.
- Voice and text share one pipeline; session flag `voice` (false = no STT/TTS) — used by the classroom simulation.
- One static client app: team UI (`src/presentation`, `src/teaching/ui`, design) as a workspace package (e.g. `@tutor/visual`) used by `client/`; Abdul's design = entry flow; Can's canvas = main area.
- Keep the team's tests passing against the moved code. If not stable by morning: don't merge `night/team-integration` into main; main then keeps the voice app with the team canvas via worker tools (already on their branch).

## Waves
0. `night/base`: merge `agent/voice-tutor` into `integration/abdul-voice`; all tests green; architecture note of the two apps (client/ voice app vs src/ team app) and how they unify.
1. Parallel from `night/base` (lead first freezes the shared table/reducer contract in `docs/CONTRACT-night.md`):
   - `night/team-integration` (design above; split into module+shared / worker / client agents)
   - `night/llm` (set_topic action + prefetch + compact index; memory on Haiku)
   - `night/classroom-core` (SpacetimeDB: roles, waiting, teacher session, documents, simulation incl. 20 seed students + LLM student turns + text-only sessions, dashboard summaries/clusters procedures, 30 s cadence + impersonation pause; worker text mode)
   - `night/vad` (client/src/audio soft-onset robustness)
2. From the merged result:
   - `night/ui` (team design: entry flow, student/teacher selection, wait-for-teacher, AI bubble + avatar, visualization-first layout, teacher dashboard + observe frame)
   - `night/lesson-2min` (Can's rigid 2-minute structure, keyframed visuals)
3. `night/verify-docs`: in-depth tests (typical + edge cases, latency, simulation, summaries, impersonation), docs (README, docs/ARCHITECTURE.md, services/libraries), `docs/NIGHT_REPORT.md`, merge to `main`.

## Conventions
- Every local CLI/HTTP call: `NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost`. `spacetime` at `~/.local/bin/spacetime`; the CLI identity owns local DBs; live DB `voice-tutor` (lead only). Agents publish to their own DB names.
- Never commit `.env*`, keys, `.spacetime-data/`, generated audio. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- User's internet is unstable: classify external API failures, retry, don't chase them.

## Status log
- night/memory-haiku DONE (pushed): `spacetimedb/src/anthropic.ts` `callAnthropicJson(ctx, {system,user,schema,effort,maxTokens,model,timeoutMs})` → reuse for dashboard summaries/clusters and simulated student turns. Known pre-existing bug to fix in classroom-core: extraction window sent twice (job row deleted when it starts; a turn appended during the call schedules a duplicate job) → add a running marker on job/cursor.
- night/vad DONE (pushed b80e5a2, 74d9160): re-entry threshold 0.25 between phrases, activity hold (cap +1000 ms), onset-based pre-roll (≤1200 ms; barge-in keeps 320). E2E 8/8 twice; turn-end latency unchanged. TODO in docs wave: client/README + latency doc mention VAD_REENTRY_THRESHOLD, VAD_TURN_HOLD_MAX_MS, VAD_PREROLL_MAX_MS, ?vad_frame_dump=1.
- night/base DONE (5b2538c). night/integration created = base + memory-haiku + vad (+ docs NIGHT_PLAN/CONTRACT, 998b183). All workspace tests green (370). Known: team canvas path latency p50 4.9 s (whole canvas JSON before narration; ~50% canvas rejections) → fixed by night/pipeline (moment streaming). Interrupt in the LAST sentence leaves tutor turn interrupted=false (needs interrupt(sessionId, utteranceId)) → wave 3 or pipeline.
- Wave 1 started: night/pipeline, night/client-static, night/classroom-core (Opus, worktrees). Deferred to wave 2: night/llm (set_topic action + prefetch + compact index) after pipeline; night/ui; night/lesson-2min.
- night/classroom-core DONE (c5a2395) + merged into night/integration (tests 422 green). Open: text-mode tutor quality (repeated canvas narration, validator rejections) → sent to pipeline agent with stall watchdog request; dashboard math check at effort low; real students in class must call startConversation (client, UI wave); old class_summary rows after class end (UI shows only active class).
- night/client-static DONE (63db6ae) + merged (includes pipeline text mode/tables/worker mode). 720 tests green, client/dist static (no /api/teaching). Team code via alias @tutor/visual → ../src. SessionView reusable (readOnly for observe). Open: slant lesson tutor_request wiring, typed→voice switch in session, 1.5 MB chunk, e2e smoke-generation typecheck (pipeline change).
- Wave 2 started: night/ui.
- night/ui DONE (67710af) + merged (747 tests green). Screenshots docs/screenshots/ (25). Open → night/classroom-polish: late waiting students not pulled into running class; dashboard summary contains learner ids "Jonas (16)"; past-student list after class end (optional).
