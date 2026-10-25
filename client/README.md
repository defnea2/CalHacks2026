> Integrated canvas: see [VOICE_CANVAS.md](../docs/VOICE_CANVAS.md). Open `http://127.0.0.1:5175/?canvasPreview` for a database-free test.

# Client (Fibonacci)

Brand: `src/brand/Logo.tsx` (`LogoMark` picks the 20/32/48/56 px or gridded large variant; `Wordmark` is mark + "fibonacci" in Fredoka 600, loaded from Google Fonts in `index.html` and used only by the wordmark). SVGs: `docs/brand/`.

Local web client: Vite + React + TypeScript + Tailwind v4 (neutral oklch tokens as in the neoknow test client). It talks only to SpacetimeDB, through the generated bindings in `src/module_bindings/`, and builds to static files (`pnpm --filter client build` → `dist/`; no server endpoints).

## One app

This is the only frontend. The team's UI stays in the repo-root `src/` with its folder names (`app`, `teaching`, `teaching/ui`, `presentation`, `visuals`, `interactions`, `visual-math`, `session`, `shared`) and is compiled into this build through the alias **`@tutor/visual`** → `../src` (`vite.config.ts` `resolve.alias`, `tsconfig.json` `paths`). Its tests keep running at the root (`npx vitest run`, jsdom). The former root Vite app (`index.html`, `src/main.tsx`, `vite.teaching.config.ts`) and its dev-server plugin (`src/server/teachingPlugin.ts`, `/api/teaching/*`, `settings.ts`) are gone; root `pnpm dev` / `pnpm build` delegate here.

| Layer | Where |
| --- | --- |
| Session screen (voice + text, observer) | `src/session/SessionView.tsx` (`<SessionView conn sessionId readOnly? />`), canvas `LessonCanvas.tsx`, text playback `useTextPlayback.ts`, worker heartbeat `useAgentStatus.ts` |
| Beat rows → team canvas | `src/lesson/beatPlayer.ts` (`orderBeats`, `revealCount`, `BeatCanvasPlayer` over the team `VisualDirector`) |
| Team lesson app + harness | `src/screens/TeamLab.tsx` (`?lesson`, `?harness`) |
| Team `PlanningModel` over SpacetimeDB | `@tutor/visual/teaching/spacetimeModel` (`createSpacetimePlanningModel(conn, sessionId)`) |

```bash
pnpm --filter client dev     # http://127.0.0.1:5175
pnpm --filter client test    # vitest: presence/auto-join, dashboard layout + observe order + timers, VAD state machine, Smart Turn features + decisions, noise floor, PCM, playback ordering, board registry
pnpm --filter client build
```

## Screens (one connection per tab, no shared state)

| URL | Screen |
| --- | --- |
| `/` | Entry: choose a role (student / teacher). No accounts |
| `?student` | Pick or create a student (simulated classroom students are hidden) |
| `?student=<id>` | "Learn by myself" (task text + optional photo, compressed to ≤ 1 MB in the browser, optional text mode → own session) or "Wait for my teacher"; "Continue" when the student has an active session |
| `?wait=<id>` | Waiting room: presence `waiting`; when a teacher's `startClassSession` links a new session for this learner (or, if a class is already running, `setPresence('waiting')` links one at once: late joiner), the tab jumps to it (`?session=<id>&join=1`). Text mode can be chosen here (`setSessionVoice(false)` before the jump) |
| `?teacher` | Pick or create a teacher |
| `?teacher=<id>` | Class setup: learning goals, content to cover, how to teach, optional material (image compressed to ≤ 1 MB, Markdown or .txt ≤ 50 000 chars), number of simulated students (0–20; groups have 2 or 4 students, so even numbers fit best), students online now → `startClassSession` → dashboard. "Open dashboard" when a class is running |
| `?class=<id>` | Teacher dashboard (below) |
| `?session=<id>&join=1` | Same screen, opened by the waiting room: voice sessions show "Join the lesson" (one click for the AudioContext, then `startConversation`), typed sessions call `startConversation` at once |
| `?observe=<id>` | Observer: `<SessionView readOnly />` (the classroom dashboard reuses it with `embedded`). Plays nothing, no inputs; reveals follow `reply_sentence.status = played` |
| `?lesson` | The team's lesson app (prepared/sample lessons, slant lesson, math studio, development tools; all offline). "Start" on a question creates a text-mode SpacetimeDB session (`?learner=<id>` or a fresh guest learner) and opens it in the session screen. `?lesson&adapter=1` instead runs the team's `Lesson` UI on `TeachingSession` + `createSpacetimePlanningModel` (presentation only: the module keeps the answer keys, so its local feedback is not authoritative) |
| `?harness` | The team's planning harness (offline fixtures) |
| `?overview` | All active sessions (ad-hoc and class) with learner, phase, turn state; links open the observer; running class sessions link to their dashboards |
| `?miccheck` | Runs microphone + VAD locally, sends nothing. Useful to check VAD assets and timings |
| `?profile=<learnerId>&as=<teacherId>` | Student profile full page (same panel as the dashboard drawer; works without a running class, e.g. for the seeded demo users). `&insightsFixture` (or `=empty`) shows a local fixture instead of calling the module |

### Student presence and auto-join (`lib/presence.ts`, `stdb/usePresence.ts`)

- Waiting room → `setPresence(id, 'waiting')`; an active session tab → `'in_session'`; closing the page (`pagehide`) → `'offline'` (the module also sets offline on disconnect). A hidden tab keeps its status and re-asserts it when visible again (a reconnect may have set it offline). An ended session is left to the module (`endClassSession` sets `waiting`).
- The session tab watches the learner's sessions: a newer active class session (the teacher started a class while the student was in an ad-hoc session) → jump to it (`&join=1`); the class session on screen ended → back to the waiting room after 2.5 s.

### Tutor avatar (`components/TutorAvatar.tsx`)

Own SVG/CSS character (no external assets). States: `idle` (breathes, blinks), `listening` (halo follows the microphone level), `thinking` (`session.turnState = thinking`: eyes up, three pulsing dots, gentle sway), `speaking` (mouth opens with the playback RMS from `PlaybackQueue.level()`, an `AnalyserNode` after the output gain; text mode and observers use a synthetic rhythm). The level is written per animation frame to the CSS variable `--lv`, no React renders. The learner's own voice: five bars on the mic level and the latest transcribed phrase next to the microphone button. Reduced motion: only state changes.

### Teacher dashboard (`screens/Dashboard.tsx`, layout logic in `lib/dashboard.ts`)

- Top: `class_summary.summary`, "Updated N s ago · next in N s" (from `class_summary.updatedAt` and `dashboard_state.nextDueAt`; "updating…" while `running`, "paused while you observe" while impersonating), Refresh button → procedure `refreshDashboard(classSessionId)`. The module refreshes every 30 s by itself.
- Below: `student_cluster` rows of the class (active students only): short name, short LLM description, student cards. Four card slots per row: a cluster of 4 fills a row, clusters of 2 pair up (`clusterRows`; the module's odd-class exception, one cluster of 3, takes a row of 4 slots). Students not in any cluster yet (before the first summary) are listed below.
- Card: name, lesson stage (subtle), tutor turn state (dot), latest chat in/out (`turn` rows, greyscale and greyed out). Hover/focus → "Observe".
- Observe: a frame over the dashboard with `<SessionView readOnly embedded />` of the student, Previous / Next (dashboard order, wraps around; `observeOrder` + `stepObserve`), Stop (Esc). Calls `setImpersonation(classSessionId, learnerId)` on open and on every switch and `setImpersonation(classSessionId, 0)` on stop, page hide and unmount.
- "All sessions" tab: one table row per student (group, stage, tutor state, turns, latest message, Observe). "End class session" (two clicks) → `endClassSession`.
- Subscriptions: `class_session`, `class_summary`, `student_cluster`, `dashboard_state`, `session WHERE class_session_id = X`, `learner`, `teacher`, plus `turn` and `lesson_state` per linked session.
- **Profile** (card, next to Observe; also in the "All sessions" row): right-side drawer (`insights/ProfileDrawer.tsx`, Esc / × / backdrop close) with `<StudentProfile learnerId teacherId />`.

### Student profile (`insights/StudentProfile.tsx`, `insights/useLearnerInsights.ts`, wording in `lib/insights.ts`)

Long-term information only (no live status): what the tutor has learned about the student, in teacher language. Memory tables stay private; the panel calls the procedure `learnerInsights({ learnerId, teacherId, key })` once on open and on Refresh (no polling) and parses `LearnerInsightsResult` (`shared/src/insights.ts`). The key comes from `localStorage['tutor.insightsKey']` (empty by default; when the module has `INSIGHTS_KEY` set, a "locked" result shows a key field that stores it). On an error the last good profile stays on screen; `ok:false` reasons are shown in plain words.

- Header: name, age, grade, learning style, "simulated" badge + persona, "N sessions since …".
- **At a glance**: 1–2 sentences built deterministically from the data (`atAGlance`, no LLM call), **Next focus** from the latest session summary.
- Notes in sections: "Still mixing up" (misconception), "What helps" (strategy worked/unknown + preference), "What didn't help" (strategy didnt), "Memory aids" (mnemonic), "Can do now" (understood), "In their own words" (quote). Confidence and sightings as words ("clearly · seen 3 times · 2 days ago"), evidence quote in italics ("— said in session 4"), a "seeded" tag for notes from the starting profile.
- Mastery by category: bar + band (not started / beginning / getting there / secure / mastered). Past sessions: topic, task, summary, date.
- Privacy guard (`test/insights.test.ts`): nothing under `src/session/`, nor `StudentHome.tsx`, `WaitingRoom.tsx`, `SessionScreen.tsx`, imports `insights/` or mentions `learnerInsights`.

Subscriptions are narrow: a session tab subscribes to `session WHERE id = X`, `learner WHERE id = L`, and `phrase`, `turn`, `reply_sentence`, `board_item`, `turn_metrics`, `playback_flush`, `audio_out`, `beat`, `lesson_state`, `canvas_state` `WHERE session_id = X`, plus the single-row `agent_status`. Only the pick-user and overview screens read all learners and all active sessions.

## Config

Every value of `VOICE_DEFAULTS` and `PLAYBACK_DEFAULTS` (`@tutor/shared`) can be overridden with a lower-case query parameter, for example `?vad_turn_ms=900&barge_in_threshold=0.8&sentence_pause_ms=150`. Smart Turn: `?smart_turn=0` (off, silence-only turn end), `?smart_turn_threshold=0.5`, `?smart_turn_min_silence_ms=600`. So can the client-only knobs in `src/config.ts` (`vad_candidate_gap_ms`, `vad_hysteresis`, `noise_floor_max_prob`, `playback_gap_timeout_ms`, `playback_lead_ms`, `vad_model=v5|legacy`).

SpacetimeDB: `VITE_SPACETIME_URI` / `VITE_SPACETIME_DB` (defaults `ws://127.0.0.1:3000`, `voice-tutor`), overridable with `?uri=` and `?db=`. Mic processing: `?mic_aec=0`, `?mic_ns=0`, `?mic_agc=0` turn off the browser's echo cancellation, noise suppression and auto gain (default on). Other params: `?debug=0` hides the debug panel, `?theme=dark|light`. UI copy lives in `src/app-config.ts`.

## Voice pipeline

- `audio/AudioCapture.ts`: `getUserMedia` with echo cancellation, noise suppression and auto gain on; `@ricky0123/vad-web` (Silero v5, ONNX Runtime Web) only provides 16 kHz frames (32 ms) and speech probabilities; its own segmenting is disabled.
- `audio/vadMachine.ts` (pure): phrase/turn state machine. Speech starts when the probability is ≥ threshold **and** the frame is `NOISE_SNR_DB` above the noise floor, for `VAD_MIN_SPEECH_MS`. Then: new `phraseId` (unique per session, continues after the highest existing one on reload), `seq = 0` with `VAD_PREROLL_MS` of pre-roll, a chunk every `AUDIO_CHUNK_MS` (whole frames, so 160 ms), `final` after `VAD_PHRASE_MS` of silence, a new phrase after `VAD_MAX_PHRASE_MS`, `turn_end` after `VAD_TURN_MS` of silence since the last speech. While the tutor speaks (local playback or `turnState = speaking`): `BARGE_IN_THRESHOLD` and `BARGE_IN_MIN_MS`, then `barge_in` and a normal phrase.
- Soft-onset robustness (`night/vad`, client knobs in `CLIENT_DEFAULTS`): between phrases of an open turn (tutor not speaking) a lower re-entry threshold `VAD_REENTRY_THRESHOLD` (0.25, + noisy boost) opens a phrase sooner; any speech-like frame in an open turn (candidates and misfires included) restarts the turn-end wait, capped at `VAD_TURN_HOLD_MAX_MS` (1000) beyond the normal wait; non-barge-in phrases get pre-roll from the energy onset (up to `VAD_PREROLL_MAX_MS` 1200; barge-in keeps 320). Debug: `?vad_frame_dump=1` logs `vad.frame_dump` (per-frame probability, dB, state) about once a second.
- Smart Turn (semantic turn end, `SMART_TURN=1`): at every silence phrase end the machine emits `smart_turn_request` with the turn's audio (pre-roll, phrases and pauses, last ≤ 8 s). `audio/SmartTurn.ts` runs Pipecat Smart Turn v3.2 (int8 ONNX, Whisper-Tiny encoder) in a Web Worker (`smartTurn.worker.ts`, onnxruntime-web wasm, 1 thread; `smartTurnFeatures.ts` is the Whisper log-mel front end in TS, checked against `transformers`). P(complete) ≥ `SMART_TURN_THRESHOLD` (0.5) ends the turn once `SMART_TURN_MIN_SILENCE_MS` (750) of silence has passed; otherwise `VAD_TURN_MS` stays the fallback. Speech resuming invalidates the pending verdict; barge-in is unchanged. The model loads after the mic starts (~0.4 s); until then, or if it fails, turns end on silence only. Model + licence: `models/` (BSD-2, committed, served under `/vad/`).
- `audio/noise.ts` (pure): RMS dBFS per frame; floor = mean of frames with p < 0.3 during the first second, then an EMA with τ = 2 s. `quiet` < −50 ≤ `moderate` ≤ −35 < `noisy`. `noisy` adds 0.1 to the threshold, raises min speech to 200 ms and shows the hint.
- `audio/VoiceSession.ts`: maps events to reducers: `pushAudio(sessionId, phraseId, seq, pcm16, final)`, `endTurn` then `reportNoise(floor)` once per turn, `interrupt` on barge-in (local playback is flushed at once). Calls `markPlayed` when each sentence starts.
- `audio/PlaybackQueue.ts` + `playbackLogic.ts`: 24 kHz PCM16 from `audio_out`, strictly by `idx` within the current utterance (out-of-order blocks wait; a missing index is skipped after 6 s or when its sentence is `dropped`), silence trimmed (`TRIM_SILENCE_LEVEL`), `FADE_MS` fades, `SENTENCE_PAUSE_MS` after each sentence, gapless scheduling. `playback_flush` or barge-in stops it at once; flushed utterances never play again.

VAD assets (Silero and Smart Turn models, worklet, ORT wasm + glue) are served under `/vad/` from `node_modules` by a small Vite plugin (dev middleware; copied to `dist/vad/` on build), so everything works offline.

## Board (replaceable pack boundary)

`src/board/registry.tsx` maps kind name → renderer; renderers get the parsed content, the reveal state and (gap tasks only) the answer state with a `submit` callback that is absent in the observer. An unknown kind gets a neutral fallback (title + raw JSON). Kind names appear only inside `src/board/`; phase labels come from the pack (`getPhase`).

Reveal sync (`board/reveal.ts`): an item tagged `(utteranceId, sentenceIdx)` shows when that sentence starts playing (session tab: local playback; observer: status `played`), untagged (`0`) items show immediately, and everything shows once the utterance is over. `worked_steps` reveals one step per sentence played after it appeared.

Inline markers: the tutor writes `⟦b1⟧` in its text where an item belongs and calls `show_board_item` with `id: "b1"` after its text; the worker strips the marker and the item gets `markerPos` (character offset in the tagged sentence's `speech`; `-1` = no marker). The session tab reveals it at that word: `PlaybackQueue` reports each sentence's start on the `performance.now()` clock, its trimmed duration and leading trim, plus the TTS word timestamps from `audio_out` (`wordStartsMs`/`wordEndsMs`, Cartesia `/tts/sse`); `markerOffsetMs` maps the marker to the start of the word at/after it (end of the last word for a marker at the end), or estimates `duration × pos / speech length` without timestamps. An item whose word already played when it arrived shows at once; the observer (no audio) and a reloaded tab reveal at the sentence start.

## E2E contract

### Chrome

```
--use-fake-ui-for-media-stream --use-fake-device-for-media-stream
--use-file-for-fake-audio-capture=<wav>
--disable-features=AudioServiceSandbox     # otherwise the fake mic delivers silence on macOS
--autoplay-policy=no-user-gesture-required
```

`scripts/smoke-cdp.mjs <url> <wav|-> [seconds] [js|@file.js]` is a dependency-free CDP driver (headless Chrome, fake mic, optional JS step, prints `window.__tutor.events` as JSON lines, `SHOT=out.png` saves a screenshot).

### `data-testid`s

| testid | attributes | where |
| --- | --- | --- |
| `conn-status` | `data-status` = connecting / connected / disconnected / error | header |
| `entry-screen`, `role-student`, `role-teacher` | | entry `/` |
| `student-home`, `learner-list`, `learner-item` | `data-learner-id`, `data-learner-name` | `?student` (click → `?student=<id>`) |
| `create-user-form`, `create-name`, `create-age`, `create-grade`, `create-style`, `create-submit` | | `?student` |
| `student-start` (`data-learner-id`), `mode-self`, `mode-wait`, `learner-active-session` (continue) | | `?student=<id>` |
| `start-form`, `task-text`, `photo-input`, `text-mode`, `start-session` | | `?student=<id>` after `mode-self` (`text-mode`: checkbox, session starts with `voice = false`) |
| `waiting-screen` (`data-learner-id`), `waiting-status`, `text-mode`, `leave-waiting` | | `?wait=<id>` |
| `teacher-home`, `teacher-list`, `teacher-item` (`data-teacher-id`, `data-teacher-name`), `create-teacher-form`, `create-teacher-name`, `create-teacher-submit` | | `?teacher` |
| `class-setup` (`data-teacher-id`), `class-form`, `class-goals`, `class-content`, `class-delivery`, `class-document`, `class-document-state`, `online-count` (`data-waiting`, `data-in-session`), `sim-count-range`, `sim-count` (`data-value`), `sim-odd`, `start-class`, `class-running`, `open-dashboard` | | `?teacher=<id>` |
| `dashboard-screen` (`data-class-session-id`, `data-active`), `class-summary` (`data-version`), `summary-updated` (`data-updated-ms`), `refresh-dashboard`, `refresh-note`, `tab-groups`, `tab-all`, `end-class`, `end-class-confirm`, `class-ended`, `dashboard-error` | | `?class=<id>` |
| `cluster-grid`, `cluster-row` (`data-sizes`, e.g. `2+2`), `cluster` (`data-size`, `data-slots`), `cluster-name`, `cluster-description`, `ungrouped` | | dashboard |
| `student-card` (`data-learner-id`, `data-session-id`, `data-cluster`), `student-stage`, `student-chat`, `observe-student` (`data-learner-id`) | | dashboard |
| `all-sessions`, `all-sessions-row` (`data-learner-id`, `data-session-id`), `observe-student-row` | | dashboard, "All sessions" |
| `open-profile` (`data-learner-id`), `open-profile-row`, `profile-drawer`, `profile-close` | | dashboard (card / "All sessions" row) |
| `student-profile` (`data-learner-id`, `data-loaded`), `profile-refresh`, `profile-error` (`data-error`), `profile-key`, `profile-simulated`, `profile-glance`, `profile-next-focus`, `profile-section` (`data-section`), `profile-note` (`data-kind`, `data-outcome`), `profile-mastery-row` (`data-concept`, `data-mastery`), `profile-session` (`data-session-id`) | | profile drawer, `?profile=<id>&as=<teacher>` |
| `observe-frame` (`data-learner-id`, `data-session-id`), `observe-name`, `observe-prev`, `observe-next`, `observe-stop` | | dashboard while observing (contains `observer-screen`) |
| `tutor-avatar` | `data-state` = idle / listening / thinking / speaking | session, observer, entry, waiting room |
| `welcome-start` | | session: voice session without turns, microphone off ("Start talking" / "Join the lesson") |
| `live-phrase` | | session, inside `mic-state` |
| `session-screen` / `observer-screen` | `data-session-id`, `data-mode` = voice / typed | |
| `lesson-canvas` | `data-beats` (rows in play order), `data-shown` (on the canvas) | session, observer (contains `.teaching-canvas`) |
| `lesson-narration`, `lesson-stage` (`data-stage`), `lesson-thinking`, `agent-status` (`data-online`) | | session, observer |
| `text-form`, `text-input`, `text-send`, `intent-another_way`, `intent-smaller_step`, `intent-continue`, `intent-demonstrate`, `lesson-help`, `stage-status` | | session |
| `lesson-check` (`data-kind`), `check-prompt`, `choice-option` (`data-option-id`), `check-picture` | | session, while `lesson_state.awaitingResponse` |
| `lesson-playback`, `playback-pause`, `playback-next`, `playback-skip`, `playback-replay` | | text sessions with more than one beat |
| `learner-name`, `session-code` | `data-session-id` | header |
| `phase-indicator` | `data-phase` (id), text = pack label | |
| `topic-indicator` | `data-category`, `data-concept` | |
| `turnstate-indicator` | `data-state` | |
| `noise-indicator` | `data-noise` = quiet / moderate / noisy, `data-floor` (dBFS) | session, miccheck |
| `noise-hint` | | session |
| `start-talking`, `stop-talking`, `end-session`, `open-observer` | | session |
| `mic-state` | `data-listening`, `data-speaking`, `data-tutor-audio` | session, while talking |
| `task-display`, `session-photo-input`, `photo-state` | `data-state` | session |
| `turn-photo` | `data-state` = none / uploading / pending / sent / error | session (`PhotoButton`: camera button in the controls row) |
| `photo-button`, `photo-modal`, `photo-video`, `photo-capture`, `photo-review`, `photo-retake`, `photo-use`, `photo-pick`, `photo-file`, `photo-chip`, `photo-remove` | | session: take a picture at any time (live camera preview via getUserMedia; file/`capture` input without a webcam), compressed to a ≤ 1 MB JPEG, `attachImage`; the chip says "Will be sent with your next answer" until the next turn closes |
| `caption-photo` | | captions: "[photo sent]" on the student turn a photo went out with (also in the observer) |
| `captions` | | |
| `caption-student` | `data-ref` = turn idx; children `caption-phrase` with `data-id` (phraseId), `data-status` | |
| `caption-tutor` | `data-ref` = utteranceId; children `caption-sentence` with `data-id` (idx), `data-status` | |
| `board` | | |
| `board-item` | `data-kind`, `data-idx`, `data-id`, `data-revealed` = true / false (hidden items stay in the DOM with `hidden`), `data-known` | |
| `worked-step`, `gap-choice`, `gap-input`, `gap-submit`, `gap-state` (`data-state` = open / correct / wrong), `board-fallback` | | inside board items |
| `debug-panel`, `metrics-table`, `metrics-row` | row: `data-turn`, `data-utterance`, `data-first-audio-ms`, `data-first-playback-ms` (ms after turn end) | |
| `local-latency` | | tab-local turn end → first audio heard |
| `event-log` | | |
| `overview-table`, `overview-row` (`data-session-id`, `data-phase`, `data-turn-state`), `overview-observe`, `overview-class` | | overview |
| `miccheck-screen`, `miccheck-start`, `miccheck-meter`, `miccheck-count-<event>` | | miccheck |
| `error`, `render-error`, `session-missing`, `session-ended` | | |

### `window.__tutor`

```ts
window.__tutor = {
  events: LogEvent[],            // {t: performance.now(), wall: Date.now(), type, ...data}, last 5000
  ofType(prefix): LogEvent[],    // 'vad' matches 'vad.*'
  clear(),
  config,                        // effective settings (after URL overrides)
  state: {                       // updated by the active screen
    route, connStatus, sessionId, sessionReady, phase, turnState, category, concept,
    listening, noise, noiseFloorDb, tutorAudio, localLatencyMs: number[],
    phrases: {phraseId, turnIdx, status, text}[],
    sentences: {utteranceId, idx, status, display}[],
    boardItems: {id, idx, kind, visible, utteranceId, sentenceIdx, markerPos, answerState}[],
    lesson: {mode, stage, awaiting, beats, shown, agentOnline},
    observing, flushes,          // observer only
    dashboard: {classSessionId, active, students, clusters: {name, size, slots}[], rows: number[][], order: string[], observing, summaryVersion},  // dashboard only
  },
  voice,                         // VoiceSession while talking (voice.playback, voice.ctx)
}
```

Event types:

| type | data |
| --- | --- |
| `conn.connecting` / `conn.connected` / `conn.error` / `conn.disconnected` | uri, db, identity, error |
| `sub.applied` / `sub.error` | label, queries |
| `reducer.call` / `reducer.ok` / `reducer.error` | name, args (bytes summarized), ms, error |
| `capture.starting` / `capture.mic` / `capture.started` / `capture.stopped` / `capture.error` | mic label + track settings |
| `vad.frame_stats` (1/s) | frames, meanDb, maxDb, maxProb, floorDb, tutorSpeaking |
| `vad.speech_start` | phraseId, bargeIn, prerollMs |
| `vad.chunk` | phraseId, seq, ms, final |
| `vad.phrase_end` | phraseId, durationMs, reason = silence / max_length / stop |
| `vad.turn_end` | noiseDb, reason = silence / smart_turn / stop, silenceMs (silence since the last speech frame) |
| `vad.smart_turn` | requestId, prob (P turn complete, null if not run), ms (request → verdict, main thread), decision = complete / incomplete / stale (speech resumed or turn already over) / skipped (a newer request superseded it) / unavailable (model not loaded), ended (this verdict ended the turn), silenceMs (at the verdict), featMs, inferMs (worker), audioMs (input length) |
| `smart_turn.ready` / `smart_turn.error` | loadMs (fetch + session + warm-up), fetchMs, bytes, totalMs / error |
| `vad.barge_in` | speechMs |
| `vad.misfire` | speechMs |
| `vad.tutor_speaking` | value |
| `noise.state` | state, floorDb |
| `audio.context` | sampleRate, state |
| `audio.received` | utteranceId, idx, bytes, sampleRate |
| `audio.scheduled` | utteranceId, idx, durationMs, inMs, trimmedStart, trimmedEnd |
| `audio.play_start` / `audio.play_end` | utteranceId, idx (play_start also durationMs, words = number of TTS word timestamps) |
| `board.seen` / `board.reveal` | id, utteranceId, sentenceIdx, markerPos (reveal also markerAt: when the marker word plays, `performance.now()` clock, or null) |
| `audio.dropped` / `audio.empty` | utteranceId, idx |
| `audio.flush` | utteranceId (0 = current), reason = playback_flush / barge_in / destroy, stopped |
| `latency.turn_end_to_first_audio` | ms, utteranceId |
| `observer.flush` | utteranceId |
| `lesson.beat_shown` / `lesson.beat_error` | key (`utteranceId:idx`), sentenceIdx / error (the canvas resynced to `canvas_state`) |
| `ui.*` | pick_learner, class_join (waiting room → class session), class_follow (session tab follows to a new class session / the waiting room), class_autostart, start_class, impersonate, start_talking, start_failed, photo_failed, render_error, text_turn (intent, chars), interaction_rejected, text_mode_failed |
