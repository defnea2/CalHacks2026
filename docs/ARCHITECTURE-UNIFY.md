# Unifying the team app (`src/`) with the SpacetimeDB architecture

Written on `night/base` (merge of `agent/voice-tutor` into `integration/abdul-voice`). Input for the
`night/team-integration` agents. Design (approved): `/Users/leanderneubronner/.claude/plans/night-plan.md`
→ "Team integration design". Principle: the team's contribution is methodology + UI; SpacetimeDB owns
state and validates every change; the worker only streams the LLM; pure logic lives in `shared/`.

## 1. What exists today (two apps in one repo)

| | Voice app (ours, pnpm workspace) | Team app (root `calhacks-visual-engine`) |
|---|---|---|
| Entry | `client/index.html` → `client/src/main.tsx` (Vite, port **5175**) | `index.html` → `src/main.tsx` → `src/app/App.tsx` (Vite, port **5173**) |
| Data path | SpacetimeDB only (reducers up, subscriptions down) | `fetch('/api/teaching/*')` → Vite dev-server plugin → Anthropic |
| LLM | `worker/` (Anthropic Haiku 5.5, streaming, tools) | `src/server/anthropicModel.ts` (raw `fetch` to `api.anthropic.com/v1/messages`, SSE) |
| Speech | STT/TTS in module procedures, playback in client | none (text-first); `TeachingSession` has a voice mode with exact phrases |
| Canvas | `client/src/board/AnimatedMathBoard.tsx` already renders the team canvas (`src/presentation/TeachingCanvas`, `voice/SpeechCanvasPlayer`) | `src/presentation/*` (same canvas) |
| Build | static (`pnpm --filter client build`) | **not static** — the planner lives in the Vite plugin (`apply: "serve"`) |

Already integrated by the team (Can) on their branch and kept by the merge: voice path uses the team
canvas: `show_board_item` with kind `math_canvas` (schema `shared/src/lesson/pack/mathCanvasGeneration.schema.json`,
validated by `src/presentation/voice/validate.ts`), self-narrated moments (`ctx.narrate`), verified speech
(only canvas narration / `ask_learner` / `visual_unavailable` speak), `ask_learner`, `visual_unavailable`.

## 2. Inventory of `src/` (≈10.5k lines non-test)

| Folder | What | Key files | Role after unification |
|---|---|---|---|
| `src/app` | Root app shell: tabs (lesson, math studio, guided, sandbox), CSS | `App.tsx`, `styles.css`, `workspace.css` | UI shell → becomes part of the one static client (design kept) |
| `src/teaching` | Lesson state machine + planner contract (zod) | `TeachingSession.ts` (355), `TeachingPlanner.ts` (284, `PlanningModel = (request, signal, onProgress) => Promise<unknown>`), `contracts.ts` (zod: `TeachingStep`, checks, evidence), `checks.ts` (`assessResponse`), `validateStep.ts`, `streaming.ts` (blueprint/beat: `preflightStep`, `extendBlueprint`), `policy.ts` (`allowedPhases`), `prompts.ts`, `preparedLessons.ts`, `shearTutor.ts` | Pure parts (contracts, checks, validateStep, streaming, policy, numbers, language) → `shared/` (or a `@tutor/teaching` workspace package importable by module + worker + client). `TeachingSession` keeps presentation state only; authoritative lesson state → module tables |
| `src/teaching/ui` | Lesson UI | `LessonWorkspace.tsx` (201: endpoint field + `/status` probe), `SlantLesson.tsx` | Keep UI; replace `fetch` endpoint/status with SpacetimeDB adapter + `agent_status` row |
| `src/teaching/dev` | Dev harness, demo model | `TeachingHarness.tsx`, `demoModel.ts` | Keep as dev tools (offline samples) |
| `src/server` | **The non-static part** (Vite plugin) | `teachingPlugin.ts` (endpoints), `anthropicModel.ts` (streaming planner, raw fetch), `streamingLesson.ts` (190: incremental JSON → moments → beats, open blueprint, truncate+recap on failure), `compactLesson.ts` (`expandCompactLesson`, `compactBeat` against `CanvasState`), `planning.ts` (`parseModelRequest`, `planningPrompt`, `validateModelStep`, `generatePlan` with one repair), `schemaContract.ts`, `shearTutor.ts`, `codexModel.ts` (legacy local bridge), `settings.ts` | Planner streaming (`anthropicModel`, `streamingLesson`) → **worker**; compile/validate (`compactLesson`, `planning.validateModelStep`, `schemaContract`) → **shared** (used by worker early and **module** authoritatively); `teachingPlugin.ts` + `settings.ts` deleted; `codexModel.ts` dropped (or dev-only) |
| `src/presentation` | Canvas + visual director | `TeachingCanvas.tsx`, `VisualDirector.ts`, `canvasState.ts`, `contracts.ts`, `demo-lessons.ts`, `GuidedWorkbench.tsx`, `math/*` (MathWorkbench, LiveControls, models, teaching, ShearProof, rehearsals), `voice/*` (`SpeechCanvasPlayer`, `validate`, contracts) | Stays as the canvas library (client). `canvasState.ts` + `voice/validate.ts` are pure → also used by module validation |
| `src/visuals`, `src/interactions`, `src/visual-math` | Interactive activities (grouping, bars, number line, shapes, diagram), pointer drag, shear math | `*Activity.tsx`, `usePointerDrag.ts`, `shear.ts` | Client UI; learner manipulations → `submitInteraction` reducer |
| `src/session`, `src/shared` | Scene reducer, shared contracts, fixtures | `sceneReducer.ts` (244), `contracts.ts` (411), `fixtures.ts` | Pure: scene reducer is the natural `canvas_state` transition function (module) |

### HTTP endpoints of the Vite plugin (`src/server/teachingPlugin.ts`) and their replacement

| Endpoint | What it does today | Replacement |
|---|---|---|
| `POST /api/teaching/plan` (JSON or `text/event-stream`) | `parseModelRequest` → Anthropic stream (`anthropicModel` + `streamingLesson`) → SSE `blueprint` / `beat` / `complete` / `error`; 45 s deadline, 15 s after the first beat; max 4 concurrent, one per session; repair round before the first beat | Trigger = student `turn` (voice or `submitTextTurn`, buttons as turns with `intent`). Worker runs the same planner and calls `addBeat(sessionId, utteranceId, idx, visualJson, narration)` per complete moment; module compiles/validates against `canvas_state`, writes `beat` (+ `reply_sentence`, `tts_job` in voice mode); reject → worker repair/recap per contract. Deadlines/concurrency stay in the worker (per-session map) |
| `GET /api/teaching/status` | provider, model, busy, configured, streaming | Public `agent_status` row (heartbeat from the worker, model + busy sessions) |
| `POST /api/teaching/shear-feedback` | Slant-lesson tutor reply (Anthropic, 30 s, max 4) | Request row (e.g. `tutor_request`) → worker → result row; or a query tool of the normal reply loop |

### Client-side seam

- `src/teaching/modelAdapter.ts`: `createStreamingPlanningModel(endpoint, fetch)` / `createHttpPlanningModel` implement
  `PlanningModel`. Replace with `createSpacetimePlanningModel(conn, sessionId)` implementing the same function type:
  call the trigger reducer, subscribe to `beat` rows of the new utterance, feed `onProgress({type:'blueprint'|'beat'|'complete'|'error'})`
  in arrival order, resolve with the complete step. `TeachingSession` and the UI stay unchanged.
- `LessonWorkspace.tsx`: endpoint/status fields → read `agent_status`.

### Tests that must move with the code

`src/server/*.test.ts` (anthropicModel, compactLesson, planning, schemaContract, streamingLesson, shearTutor, codexModel),
`src/teaching/*.test.ts` (planner, session, modelAdapter, streamingAdapter, textStreaming, voiceSession, preparedLessons),
`src/presentation/**`, `src/visuals/**` tests: 38 files / 250 tests, all green on `night/base` (`npx vitest run` at the root).

## 3. Concrete move list for `night/team-integration`

1. **shared** (pure, no Node/browser): move `src/teaching/{contracts,checks,validateStep,streaming,policy,numbers,language}.ts`,
   `src/server/{compactLesson,planning(validate parts),schemaContract}.ts`, `src/presentation/{canvasState,voice/validate,voice/contracts}.ts`,
   `src/session/sceneReducer.ts`, `src/shared/contracts.ts` into a workspace package (suggested `@tutor/teaching`, keep folder names).
   zod is a dependency — confirm it bundles into the SpacetimeDB module (`spacetime build`); if not, validate in the module
   with the existing `validateJson` + a thin port.
2. **module**: tables `canvas_state` (session, version, scene JSON), `beat` (session, utterance, idx, visual JSON, narration,
   keyframe sentence idx), `learner_event`, `lesson_state` (phase/awaiting_response/evidence), `agent_status`; reducers
   `submitTextTurn`, `submitInteraction`, `addBeat`, plus a session flag `voice: bool`. (Contract to be frozen by the lead
   in `docs/CONTRACT-night.md` before the agents start.)
3. **worker**: port `anthropicModel.ts` + `streamingLesson.ts` as a reply mode (raw `fetch` works in Node; or the Anthropic
   SDK already used by `worker/src/anthropic.ts`); keep incremental release, repair, recap, deadlines; output via reducers.
4. **client**: one Vite app. Make `src/` UI a workspace package consumed by `client/` (or move it under `client/src/team/`
   keeping paths), add the SpacetimeDB `PlanningModel` adapter, delete `src/server/teachingPlugin.ts` + `settings.ts`
   and the plugin line in the root `vite.config.ts`; `vite build` must produce static files only.

## 4. Merge decisions on `night/base` (relevant for the next agents)

- **Verified speech is the default** (team): free model text is not spoken; only `math_canvas` narration, `ask_learner`
  and `visual_unavailable`. `AgentOptions.verifiedSpeech: false` re-enables free text (tests use it).
- **Free-speech rules** (speak first, inline markers ⟦b1⟧) moved to `pack.prompts.freeSpeech`, appended to the system
  prompt only when verified speech is off; `buildToolSpecs(pack, { markers })` mentions markers only then.
- **Authored opening** under verified speech: `pack.prompts.openingScript` (`{{task}}`), spoken via the canvas-narration
  path without an LLM call (`openingLines()` in `worker/src/reply.ts`).
- **`show_board_item`**: team semantics (only `math_canvas` or a library `taskKey`; query kind so the model narrates
  after it); an item anchored at an inline marker returns `{ text: 'ok' }` (complete, no follow-up round).
- **Reveal**: exact started sentence indices (team) — dropped/skipped audio never reveals; inline markers wait for their
  word on top. Playback start events fire on the audio clock (team), with our word timing.
- **Chunker in replies**: `{ minWords: 1, maxWords: Infinity }` (team: canvas offsets count grammatical sentences).
- **Prompts**: team speech/tool rules; first-sentence-short rule (user instruction) kept; team's 12–15-word cap removed.
- Team changed worker default `ANTHROPIC_EFFORT` to `medium` (was `low`); kept.
- Ports: client 5175, team root app 5173.
