# Night report — 2026-10-25

Everything from tonight is on `night/integration`, built from feature branches that were each merged with their own `--no-ff` merge commit. `main` is fast-forwarded to it, so every feature is one merge commit on `main` and can be undone on its own:

```bash
git revert -m 1 <merge-sha>     # undo one feature (keeps everything else)
```

Team branches (`integration/abdul-voice`, `test/abdul`, `feature/visual-engine`) were never changed. The SpacetimeDB cloud migration was not touched (still local, your call).

## Start the demo (5 min)

```bash
pnpm install
pnpm dev:voice    # local SpacetimeDB + publish (no --clear, seeded users stay) + worker + client (http://127.0.0.1:5175)
node scripts/seed-demo.mjs   # only after a --clear: re-seed demo users (scripts/demo-seed.json)
```

`.env` needs `CARTESIA_API_KEY` and `ANTHROPIC_API_KEY` (OpenRouter is optional now). Speech-to-text works out of the box with Cartesia's batch endpoint (`ink-whisper`). The script and fallbacks are in **`docs/DEMO.md`** (preflight checklist, 2-minute flow, what to do if the network is slow). Screenshots of every screen: `docs/screenshots/`.

Routes: `/` entry (student or teacher) · `?student` · `?wait=<id>` waiting room · `?session=<id>` · `?teacher` · `?class=<id>` dashboard · `?observe=<id>` · `?overview` · `?lesson` (team lab, offline samples) · `?miccheck` · `?debug=1`.

## What changed, by feature (merge commits on `night/integration` = `main`)

| # | Branch | Merge commit | What it does | Undo |
|---|---|---|---|---|
| 0 | `night/base` | `8179aa4` (inside base) | Our voice work merged into the team branch `integration/abdul-voice` (13 conflicts resolved, team methodology kept: verified speech, canvas tools). Inventory of the team app: `docs/ARCHITECTURE-UNIFY.md` | base of everything, not revertable on its own |
| 1 | `night/memory-haiku` | `5c0fbed` | Memory extraction + session summaries on Claude Haiku 5.5 (raw HTTP, structured outputs) from SpacetimeDB procedures; OpenRouter fallback | `git revert -m 1 5c0fbed` |
| 2 | `night/vad` | `bf942ea` | Soft word onsets after thinking pauses: re-entry threshold, activity hold (cap 1 s), onset pre-roll. Fixed the split "um" turns and the noisy transcript (E2E 8/8 twice) | `git revert -m 1 bf942ea` |
| 3 | `night/classroom-core` | `4284179` | Classroom backend: teachers, presence, class sessions (every online student joins), documents, simulation with 20 seed students (Haiku writes their messages), dashboard summary + clusters (exactly 2 or 4) every 30 s, impersonation pause. `docs/CLASSROOM.md` | `git revert -m 1 4284179` |
| 4 | `night/client-static` | `ec06c1a` | One static client in the team's design (team code via alias `@tutor/visual`), SpacetimeDB planning adapter, **Vite server removed** (`client/dist` is pure static files) | `git revert -m 1 ec06c1a` |
| 5 | `night/ui` | `e321404` | Entry flow (role → user → learn alone / wait for teacher), tutor avatar + thinking bubble, mic bars, teacher setup (goals, content, delivery, document, simulated students), dashboard (summary, groups 4 per row, greyed interactions, hover → Observe), observe frame (prev / next / stop) | `git revert -m 1 e321404` |
| 6 | `night/pipeline` | `3b22fa5` | The team's lesson planner in SpacetimeDB: pure code in `@tutor/teaching` (`teaching/`), tables `canvas_state` / `beat` / `lesson_state` / `learner_event` / `agent_status`, worker lesson mode releases moments as they stream, module validates every beat. Text mode (`voice=false`), heartbeat, stall watchdog. **Turn end → first audio 4.3 s → 2.5 s**, 0 rejected beats in E2E | `git revert -m 1 3b22fa5` (also needs 4 and 5 reverted — they build on it) |
| 7 | `night/classroom-polish` | `130c061` | Late joiners join a running class; no learner ids in dashboard text; `DASHBOARD_EFFORT` (low kept, measured) | `git revert -m 1 130c061` |
| 8 | `night/dashboard-watchdog` | `3ff724a` | Dashboard refresh recovers by itself after a crash (backup job) | `git revert -m 1 3ff724a` |
| 9 | `night/docs` | `b776f79` | `docs/ARCHITECTURE.md` (diagrams, every table/reducer, why it's SpacetimeDB-idiomatic), `docs/SERVICES.md`, README rewrite, `docs/DEMO.md` | `git revert -m 1 b776f79` |
| 10 | `night/config-fixes` | `3ec0a70` | STT default = Cartesia batch `ink-whisper` (the local ink-2 proxy can't be reached from procedures); OpenRouter optional; `.env.example` cleaned | `git revert -m 1 3ec0a70` |
| 12 | `night/demo-seed` | `5566987` | Demo users Ava Chen, Sam Rivera, Priya Patel; teachers Ms. Park, Mr. Alvarez; copy-paste tasks + class setups in `docs/DEMO.md`; `voice-tutor` DB published + seeded | `git revert -m 1 <sha>` |
| 11 | `night/lesson-2min` | `983c230` | Can's rigid 2-minute arc (default `LESSON_ARC=demo2min`): authored lead-in → visualized explanation → formalization (equation on its sentence) → one task → hand back (one repair if needed). Explanation 8–11 s, formalization 21–32 s, task 33–49 s after the click; worst case ~90 s. Topic prefetch + library index (no added latency), `interruptUtterance` (barge-in in the last sentence), E2E lesson-mode timeouts. Its E2E run 1: 8/8 | `git revert -m 1 983c230` (or set `LESSON_ARC=adaptive`) |


### Morning wave (2026-10-25, 06:30–08:00) — same rules: one `--no-ff` merge per branch on `main`

| # | Branch | Merge commit | What it does | Undo |
|---|---|---|---|---|
| 13 | `night/pitch` | `0458f8f` | `docs/PITCH.md`: 60 s / 3 min pitch, "Why SpacetimeDB" with sourced numbers, judge Q&A | `git revert -m 1 0458f8f` |
| 14 | `night/seed-data` | `c16806d` | `seedMemory` reducer (agent-only) + seeded memory for Ava/Sam/Priya; `scripts/simulate.mjs`; optional reset of simulated students (`startClassSessionWith`, `resetSimulatedStudents`, checkbox + button in teacher setup) | `git revert -m 1 c16806d` |
| 15 | `night/insights-module` | `86ba70e` | `learnerInsights` procedure (teacher-gated, optional `INSIGHTS_KEY`), contract `shared/src/insights.ts` | `git revert -m 1 86ba70e` (revert 16 first) |
| 16 | `night/insights-ui` | `33420e0` | Teacher-only **Student profile**: dashboard "Profile" drawer + `?profile=<id>&as=<teacherId>`; notes in plain words, mastery, past sessions; privacy guard test | `git revert -m 1 33420e0` |
| 17 | `night/judging-docs` | `50b4add` | README "For judges", `docs/JUDGING.md` (per-track evidence, repo map), `docs/DEVPOST.md` draft; secret scan of history clean | `git revert -m 1 50b4add` |
| 18 | `night/demo-polish` | `d2a81e7` | Rehearsal fixes: beats appear when their sentence plays (no lesson spoiler in voice mode), unheard beats dropped after barge-in, debug/observer layout; 54 rehearsal screenshots | `git revert -m 1 d2a81e7` |
| 19 | `night/robustness` | `d021332` | Risk-review fixes: orphaned phrase no longer blocks a session, worker resets state on reconnect, interrupted → listening, superseded utterance dropped, crash guard, "Tap for sound" | `git revert -m 1 d021332` |

**Not merged, waiting for a decision:** `night/lesson-quality` (deterministic task guards: homework repeat by numbers, one correct option, answer not visible; equivalent-fraction grading; "Say" instead of "Type"; opening first beat +1.5 s) and `night/pushback` (confirmation before big jumps: "Are you sure I should tell you the answer?", skipping ahead; off-topic steer-back; tested as a student in text mode, transcripts in `docs/pushback-test/`).

**Final state `d021332`:** 627 unit tests green (teaching 52, shared 157, module 147, client 161, worker 110), typecheck clean, static client build. Full E2E **8/8 PASS**, 0 external flakes; turn end → first audio p50 3.44 s (min 2.87, max 5.09; the 06:25 run had p50 2.75 s — a dev stack and an agent worker ran alongside, not yet isolated); "Start talking" → opening audio p50 1.27 s.

**Incident 07:07:** the shared SpacetimeDB server died because the disk was full (`No space left on device`). 26 finished agent worktrees removed (all pushed), server restarted 07:25 with the same data; demo data intact. Keep ≥ 10 GB free.

### Late morning (08:30–09:20)
Merged on `main` (one `--no-ff` merge each, revert with `git revert -m 1 <sha>`): `night/branding` (Fibonacci name + spiral logo), `night/turn-photo` (photo any time, sent with the next turn), `night/voice-ux` (voice only, mic/speaker on at start, sound settings), `night/cloud-plan` + `night/maincloud-prep` + `night/maincloud-deploy` (docs/CLOUD_PLAN.md, docs/DEPLOY.md; **live: Maincloud `fibonacci-demo` + https://fibonacci-26f.pages.dev/**, worker on the laptop from worktree `deploy/cloud`), `night/sim-history` (full seeded history for 20 personas + demo users), `night/lesson-quality` + `night/pushback` (task guards, equivalent grading, confirm before big jumps), `night/latency-fix` (guard test; the latency rise was Cartesia STT network time, not code), `night/stdb-consistency` (TTS job cancellation, worker guard, docs/SPACETIME_AUDIT.md). `demo/video` = the stable recording state (643b75f).

**Final E2E on merged main (16:12Z run): 8/8 PASS**, 0 external flakes; turn end → first audio p50 **2.30 s** (min 0.50, max 3.31); session start → opening audio p50 0.53 s. 951 unit tests green.

In progress (side tracks, not merged): `night/identity` (identities + passwordless auth, scheduler-only guards), `night/stdb-hardening` (indexes, retention, JOIN subscriptions — initial worker sync 487 KiB → 14 KiB), `night/dashboard-live` (live chat bubbles, hover buttons, custom icons), `night/cf-dispatch` (Part B: SpacetimeDB → Cloudflare Worker per turn).

Small direct commits on `night/integration`: night plan / contract docs, `164eda5` (e2e smoke typecheck fix), this report.

Test status of the final state (`983c230`): 791 unit tests green (teaching 52, shared 157, module 127, client 131, worker 106, team app 218), typecheck clean, static client build. Final full E2E on this state (06:13–06:25, quiet machine): **8/8 PASS**, 0 external flakes; turn end → first audio p50 2.75 s (min 2.62, max 3.17); "Start talking" → opening audio p50 1.06 s. `main` = `09db721` (fast-forwarded 06:27).

## Decisions I made for you (easy to change)
- **Architecture of the team integration (approved "A")**: their planner runs in the worker, their compiler/validator in shared code, the module validates every beat against `canvas_state`. Their old tool-based canvas path stays as `REPLY_MODE=tools`.
- **Lesson effort `low`** (same latency as medium, fewer failures). Dashboard effort `low` (medium doubled latency, no better groups).
- **Thinking off** for the tutor (0.3–0.5 s faster first token).
- **Odd class size**: exactly one group of 3 (2-or-4 is impossible otherwise). The teacher UI recommends even numbers.
- **Explicit "learn by myself" sessions stay ad-hoc** when a class starts later; waiting students and late waiting students join.
- **STT**: works without a proxy now (ink-whisper). For ink-2 latency, put `stt-proxy/stt-proxy.php` on a public host and set `STT_BASE_URL` + `CARTESIA_STT_MODEL=ink-2`.

## Known issues / open
- **Latency target**: turn end → first audio p50 ≈ 2.5 s (target 2.5 s); the team methodology plans a short "meta" (goal + check) before the first moment (~1.9 s to first beat).
- **Repeated-check repair** costs +1.7 s in about 1 of 9 turns.
- **Real-device check missing**: echo cancellation / VAD with real speakers and children's voices (headphones recommended).
- Tutor quality in **text mode** was improved by the pipeline agent (no repeated narration/checks); still worth a manual look during the demo rehearsal.
- Dashboard of 8+ students takes 7–10 s per refresh (single Haiku call with the whole context).
- Bundle `index` chunk ~1.5 MB (no code splitting).
- Class page has no list of past students after a class ends.

## Incidents tonight
- An earlier full E2E (05:45) failed 5/8 while two browser suites ran at once (load average ~35): audio arrived but never played after a harness crash. Re-run alone: 8/8.
- The shared local SpacetimeDB server process died once (~05:00); restarted 05:21 with the same data dir, nothing lost.
- Two agents hit the usage limit (~04:50) and were resumed after the reset.
- One agent ran `pkill` by pattern twice (it could have stopped other workers); no lasting effect found.

## Where to read more
`docs/ARCHITECTURE.md` (start here) · `docs/SERVICES.md` · `docs/CLASSROOM.md` · `docs/DEMO.md` · `docs/NIGHT_PLAN.md` (full night log) · `docs/CONTRACT-night.md` (interfaces) · `docs/latency-internal.md`.
