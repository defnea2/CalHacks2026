# Night contract: shared interfaces for the overnight agents (frozen by the lead)

All agents branch from `night/integration`. Names below are binding; implementation details are each owner's. Additive changes only to existing tables (new columns need `.default(...)` so republishing keeps data). If you need something not listed, add it in your own section and list it in your report.

Schema location: put new tables in your own file (`spacetimedb/src/schema_<area>.ts`) and import them into `schema.ts` with one line each — that keeps merge conflicts to a few lines. Reducers/procedures in your own `spacetimedb/src/<area>.ts`, exported from `index.ts`.

## 1. Text mode and the turn pipeline (owner: `night/pipeline`, deliver FIRST — others merge it)

| Item | Definition |
|---|---|
| `session.voice: bool` (default `true`) | `false` = no STT/TTS. `addSentence`/beats insert no `tts_job`; sentences go straight to `ready`→ treated as played after a reading delay the module computes (`TEXT_SENTENCE_MS_PER_WORD`, e.g. 280 ms/word) so turn states still flow `thinking → speaking → listening`. |
| `turn.source: string` (default `'voice'`) | `'voice' \| 'text' \| 'sim'` |
| `turn.intent: string` (default `''`) | `''` (normal) or a lesson intent from the team UI: `'another_way' \| 'smaller_step' \| 'continue' \| 'demonstrate'` |
| reducer `submitTextTurn(sessionId: u64, text: string, intent: string)` | Client (and the simulation procedure via an internal helper). Appends a complete student turn (status `ready`) in one step; same TurnManager semantics as voice (one open student turn; interrupts a running tutor reply like barge-in). |
| reducer `setSessionVoice(sessionId: u64, voice: bool)` (addition, night/pipeline) | Client switch for `session.voice`. Internal callers (simulation) can pass `voice` to `sessions.startSession(ctx, {learnerId, taskText, voice})`. Typed turns call the exported helper `submitTextTurn(ctx, args, source)` from `spacetimedb/src/text_mode.ts` (source `'sim'` for the simulation). |
| Text mode details (night/pipeline) | Empty `text` is allowed with an intent (canonical phrase from `INTENT_TEXT`). A typed turn joins a live, fully transcribed spoken turn; it is refused while a spoken phrase is still being transcribed. On interrupt the heard tutor turn is appended by the module before the typed turn (the worker's later `appendTutorTurn` for that utterance is a no-op). Reading delay: `max(TEXT_SENTENCE_MIN_MS=700, words * TEXT_SENTENCE_MS_PER_WORD=280)` per sentence, sequential, via scheduled reducer `finishTextSentence` (table `text_play_job`). |
| table `learner_event` (public) | `id u64 pk autoInc, sessionId u64 idx, kind string, payload string (JSON), accepted bool, evidence string, createdAt timestamp` |
| reducer `submitInteraction(sessionId: u64, kind: string, payload: string)` | Canvas manipulation / picture submission from the team UI; validated against `canvas_state`; recorded as evidence; may trigger a reply (module decides via the team's policy). |
| table `canvas_state` (public) | `sessionId u64 pk, version u32, scene string (JSON CanvasState), updatedAt timestamp` |
| table `beat` (public) | `id u64 pk autoInc, sessionId u64 idx, utteranceId u64, idx u32, visual string (JSON, compiled+validated commands), narration string, sentenceIdx i32 (reply_sentence that speaks it, -1 none), canvasVersion u32, createdAt timestamp` |
| reducer `addBeat(sessionId: u64, utteranceId: u64, idx: u32, visual: string, narration: string)` | Agent only. Compiles/validates `visual` against `canvas_state` with the shared team compiler; on success: `beat` row + `reply_sentence` for the narration (+ `tts_job` if voice) + `canvas_state` advance. On failure: throws `SenderError` with the validator message (worker repairs per the team contract). |
| table `lesson_state` (public) | `sessionId u64 pk, stage string, awaitingResponse bool, checkPrompt string, evidence string (JSON list), notes string (JSON), updatedAt` — the team `TeachingSession` authoritative state |
| table `agent_status` (public) | `id u32 pk (0), model string, provider string, busySessions u32, lastSeen timestamp` — worker heartbeat (replaces `/api/teaching/status`) |
| `tutor_request` / `tutor_result` | Replace `/api/teaching/shear-feedback`: request row (client) → worker → result row. |

### 1a. Implemented details and additions (night/pipeline)

| Item | Definition |
|---|---|
| reducer `beginLesson(sessionId: u64, utteranceId: u64, meta: string)` (addition, agent) | The streamed lesson meta (team `StreamLessonSchema.meta`, planned first). Validated with the team schema + `fixAssessment` + the phase policy (`allowedPhases` / `phaseOptionsAfterAssessment`) and "no repeated check" BEFORE any beat. Repair rounds may call it again while no beat was accepted. |
| `addBeat` `visual` argument | A bare compact command (`{kind,...}`) or a moment without narration `{visual, interactive?, showEquation?, final?}`. `final: true` = last moment: compiled with interaction allowed, then the whole step is validated (`validateModelStep`, check prompt appended to the final narration once) and accepted into the lesson record. |
| `beat.visual` | The compiled team `VisualBeat` without narration: `{id, cues:[{id, atMs, commands}]}`. One `reply_sentence` per grammatical sentence of the narration (not one per beat: first audio sooner); `beat.sentenceIdx` = the first of them. |
| procedure `buildLessonRequest(sessionId: u64, requestId: string) -> string` (addition, agent) | JSON `{ok, request}`: the team `ModelRequest` for the current lesson state (learner profile + memory as one `session.context` item). |
| `lesson_state.stage` | `needs_plan \| presenting \| awaiting_response \| completed` (TeachingPlanner status; `presenting` while a lesson streams). `notes` = `{stepId, phase, learningGoal, approach, beatCount, check (public view: no answer key), steps:[...]}`. |
| Lesson over the utterance | All sentences played (voice: started; text: read) after the tutor turn -> presented (`awaiting_response` with a check). Barge-in / typed turn / superseding reply -> interrupted (`needs_plan`) and `canvas_state` rolls back to the scene after the last beat the learner saw. |
| Student turns | While `awaiting_response`: assessed with the team `assessResponse` (a spoken answer naming one option of a choice check counts as that choice). Intents `another_way`/`smaller_step`/`demonstrate` -> help evidence (`another_way`/`simpler`/`explain`); `continue` records nothing; other speech -> unscored context (`recordUtterance`). |
| `submitInteraction` kinds | `math_action` (team `MathAction`), `activity_action` (team `LearnerAction`), `submit` (`{}` -> response `interaction`), `choice` (`{optionId}`). Only while `awaiting_response`. Rejected ones are recorded (`accepted=false`, `evidence={error}`) instead of throwing. `submit`/`choice` record evidence and append a student turn (source `text`) so the worker plans the next step. |
| reducers `agentHeartbeat(model, provider, busySessions: u32)`, `requestTutor(sessionId, kind, payload)`, `submitTutorResult(requestId: u64, ok: bool, result: string)` (additions) | `agent_status` row 0 every 5 s; `tutor_request.status` `pending -> done \| error`, kind `shear_feedback` (payload = the team `ShearTutorRequest`), `tutor_result.result` = the team `ShearTutorReply` JSON or the error. |
| private tables | `lesson_record` (authoritative TeachingPlanner record), `lesson_plan` (lesson streaming for an utterance), `text_play_job`, `text_playback`. |
| Worker `REPLY_MODE` | `lesson` (default): the team streaming planner (`worker/src/lesson.ts`). `tools`: the previous tool loop (`show_board_item(math_canvas)`, `ask_learner`, ...), kept as a switchable fallback. `LESSON_EFFORT` default `low`. |

## 2. Classroom (owner: `night/classroom-core`)

| Item | Definition |
|---|---|
| table `teacher` (public) | `id u64 pk autoInc, name string, createdAt` ; reducer `createTeacher(name)` |
| `learner.isSimulated: bool` (default false), `learner.simRank: u32` (default 0) | simulation users (1..20, seeded order) |
| table `presence` (public) | `learnerId u64 pk, status string ('offline'\|'waiting'\|'in_session'), connectionId string, updatedAt` ; reducer `setPresence(learnerId, status)`; `clientDisconnected` marks that connection's learners offline (except simulated) |
| table `class_session` (public) | `id u64 pk autoInc, teacherId u64, goals string, content string, delivery string, documentName string, documentMime string, documentText string, active bool idx, simulation bool, simulatedCount u32, startedAt, endedAt option<timestamp>` |
| table `class_document` (private) | `classSessionId u64 pk, data bytes` (image payload; Markdown goes into `documentText`) |
| reducer `startClassSession(teacherId, goals, content, delivery, documentName, documentMime, documentText, documentData: bytes, simulatedCount: u32)` | Ends the teacher's previous class session; puts EVERY online student (`waiting` or `in_session`) into a new session linked to it (`session.classSessionId`), ending their ad-hoc session; if `simulatedCount > 0` runs the simulation (below). |
| reducer `endClassSession(classSessionId)` | |
| `session.classSessionId: u64` (default 0 = ad-hoc) | Teacher instructions/document enter `buildContext` for linked sessions. |
| table `sim_profile` (public, read-only seed) | 20 realistic students (name, age, grade, style, persona for the LLM, typical misconceptions, seed memory notes JSON) in `shared/src/classroom/simStudents.ts`; loaded in `init`. |
| Simulation | On each run: reset simulation users 1..n (delete their sessions, turns, memory notes, concept states; recreate learner rows + seed memory) in seed order; mark them `in_session`; text-mode sessions (`voice=false`). Student turns: scheduled procedure `simStudentTurn` (table `sim_turn_job`) after each tutor reply finishes (+ a small human-like delay), calling Haiku non-streaming (`callAnthropicJson` from `spacetimedb/src/anthropic.ts`) with persona + transcript + canvas/board → `submitTextTurn(..., source 'sim')`. Bounded number of turns per run (config). Tutor side = the normal worker reply. |
| table `class_summary` (public) | `classSessionId u64 pk, summary string, updatedAt, version u32` |
| table `student_cluster` (public) | `id u64 pk autoInc, classSessionId u64 idx, position u32, name string (short), description string (short LLM status), learnerIds string (JSON u64[] as strings)` — every cluster has EXACTLY 2 or 4 students (odd count: one cluster of 3, flagged in the report as the only exception) |
| procedure `refreshDashboard(classSessionId)` | Client-callable (refresh button) + scheduled every 30 s (`dashboard_job`). Non-streaming Haiku via `callAnthropicJson`: whole student context in (transcripts, phase, board/canvas, memory, lesson_state) → summary + clusters JSON; validate sizes in code. Skipped while impersonating. |
| table `dashboard_state` (public) | `classSessionId u64 pk, impersonatingLearnerId u64 (0 none), lastRunAt option<timestamp>, nextDueAt timestamp, running bool` |
| reducer `setImpersonation(classSessionId, learnerId)` | `0` stops; on stop, if `nextDueAt` passed → schedule refresh now. |
| Also fix | extraction window sent twice (job row deleted at start; add a running marker). |

## 3. Unchanged boundaries
- STT/TTS stay module procedures (STT via `STT_BASE_URL`), LLM streaming stays in the worker, the client builds static.
- Live DB `voice-tutor` is the lead's. Agents publish to their own DB names.

## 4. Client consumption of section 1 (owner: `night/client-static`)

How the static client reads the section 1 rows as implemented on `night/pipeline` (`spacetimedb/src/pipeline.ts`); code in `client/src/session/SessionView.tsx`, `client/src/lesson/beatPlayer.ts`, `src/teaching/spacetimeModel.ts`.

| Item | Client use |
| --- | --- |
| `beat.visual` | Team `VisualBeat` without narration (`{id, cues:[{id, atMs, commands}]}`; `{commands}` / bare command arrays are tolerated). Beats of a session are applied in `(utteranceId, idx)` order, contiguous only (a gap waits), to the team `VisualDirector`. |
| `beat.sentenceIdx` | First `reply_sentence` of the beat's narration (a narration may span several sentences). Voice: the beat shows when that sentence starts playing (session tab) / is `played` (observer); all beats once the utterance is over. Text: local playback (auto-advance by reading time, Pause / Next / Skip / Replay); captions of the latest utterance stop before the first beat not yet shown. |
| `canvas_state.scene` | Fallback only: when a beat cannot be applied locally the canvas resyncs to it. |
| `lesson_state.stage` / `awaitingResponse` / `checkPrompt` | Planner status; the check UI shows while `awaitingResponse` (and the session is not thinking). |
| `lesson_state.notes` | `phase` → stage label; `check` (public, no answer key) → choice buttons (`kind: 'choice'`, `options`), "Check my picture" (`math_value`/`placement`/`order`), otherwise the text input. The PlanningModel adapter reports a reply once `notes.stepId` changes to a new step with `beatCount` = the utterance's beats (the module accepts at the final beat). |
| `submitInteraction` | `math_action` / `activity_action` (payload = the team action from the local `VisualDirector`; only while a check is open), `choice` (`{optionId}`), `submit` (`{}`). The module submits the learner turn for choice/submit. |
| `submitTextTurn(text, intent)` | Typed input (`''`) and the lesson buttons: `another_way`, `smaller_step`, `continue`, `demonstrate` (empty text). |
| `setSessionVoice(sessionId, false)` | Start form "Type instead of talking" (`?voice=0`) and the team lab's live lessons. |
| `agent_status` | Row `id = 0`; online when `lastSeen` is younger than 30 s; label shows `model`. Replaces `/api/teaching/status`. |
| `tutor_request` / `tutor_result` | Not used by the client yet: the slant lesson keeps its labeled offline reply (`requestTutor('shear_feedback', …)` is the seam). |
