# Client

Local web client: Vite + React + TypeScript + Tailwind v4 (neutral oklch tokens as in the neoknow test client). It talks only to SpacetimeDB, through the generated bindings in `src/module_bindings/`.

```bash
pnpm --filter client dev     # http://127.0.0.1:5173
pnpm --filter client test    # vitest: VAD state machine, Smart Turn features + decisions, noise floor, PCM, playback ordering, board registry
pnpm --filter client build
```

## Screens (one connection per tab, no shared state)

| URL | Screen |
| --- | --- |
| `/` | Pick a user: learner list, create a test user, start or reopen a session (task text + optional photo, compressed to ≤ 1 MB in the browser) |
| `?session=<id>` | Session: header (learner, code), phase/topic/turn-state/noise indicators, "Start talking" (on a session without turns the tutor then speaks first, via `startConversation`), captions, board, debug panel (per-turn latency + event log). A reload resumes it |
| `?observe=<id>` | Observer: read-only mirror (captions, board, metrics). Plays nothing; reveals follow `reply_sentence.status = played` |
| `?overview` | Active sessions with learner, phase, turn state; links open the observer |
| `?miccheck` | Runs microphone + VAD locally, sends nothing. Useful to check VAD assets and timings |

Subscriptions are narrow: a session tab subscribes to `session WHERE id = X`, `learner WHERE id = L`, and `phrase`, `turn`, `reply_sentence`, `board_item`, `turn_metrics`, `playback_flush`, `audio_out` `WHERE session_id = X`. Only the pick-user and overview screens read all learners and all active sessions.

## Config

Every value of `VOICE_DEFAULTS` and `PLAYBACK_DEFAULTS` (`@tutor/shared`) can be overridden with a lower-case query parameter, for example `?vad_turn_ms=900&barge_in_threshold=0.8&sentence_pause_ms=150`. Smart Turn: `?smart_turn=0` (off, silence-only turn end), `?smart_turn_threshold=0.5`, `?smart_turn_min_silence_ms=600`. So can the client-only knobs in `src/config.ts` (`vad_candidate_gap_ms`, `vad_hysteresis`, `noise_floor_max_prob`, `playback_gap_timeout_ms`, `playback_lead_ms`, `vad_model=v5|legacy`).

SpacetimeDB: `VITE_SPACETIME_URI` / `VITE_SPACETIME_DB` (defaults `ws://127.0.0.1:3000`, `voice-tutor`), overridable with `?uri=` and `?db=`. Mic processing: `?mic_aec=0`, `?mic_ns=0`, `?mic_agc=0` turn off the browser's echo cancellation, noise suppression and auto gain (default on). Other params: `?debug=0` hides the debug panel, `?theme=dark|light`. UI copy lives in `src/app-config.ts`.

## Voice pipeline

- `audio/AudioCapture.ts`: `getUserMedia` with echo cancellation, noise suppression and auto gain on; `@ricky0123/vad-web` (Silero v5, ONNX Runtime Web) only provides 16 kHz frames (32 ms) and speech probabilities; its own segmenting is disabled.
- `audio/vadMachine.ts` (pure): phrase/turn state machine. Speech starts when the probability is ≥ threshold **and** the frame is `NOISE_SNR_DB` above the noise floor, for `VAD_MIN_SPEECH_MS`. Then: new `phraseId` (unique per session, continues after the highest existing one on reload), `seq = 0` with `VAD_PREROLL_MS` of pre-roll, a chunk every `AUDIO_CHUNK_MS` (whole frames, so 160 ms), `final` after `VAD_PHRASE_MS` of silence, a new phrase after `VAD_MAX_PHRASE_MS`, `turn_end` after `VAD_TURN_MS` of silence since the last speech. While the tutor speaks (local playback or `turnState = speaking`): `BARGE_IN_THRESHOLD` and `BARGE_IN_MIN_MS`, then `barge_in` and a normal phrase.
- Smart Turn (semantic turn end, `SMART_TURN=1`): at every silence phrase end the machine emits `smart_turn_request` with the turn's audio (pre-roll, phrases and pauses, last ≤ 8 s). `audio/SmartTurn.ts` runs Pipecat Smart Turn v3.2 (int8 ONNX, Whisper-Tiny encoder) in a Web Worker (`smartTurn.worker.ts`, onnxruntime-web wasm, 1 thread; `smartTurnFeatures.ts` is the Whisper log-mel front end in TS, checked against `transformers`). P(complete) ≥ `SMART_TURN_THRESHOLD` (0.5) ends the turn once `SMART_TURN_MIN_SILENCE_MS` (600) of silence has passed; otherwise `VAD_TURN_MS` stays the fallback. Speech resuming invalidates the pending verdict; barge-in is unchanged. The model loads after the mic starts (~0.4 s); until then, or if it fails, turns end on silence only. Model + licence: `models/` (BSD-2, committed, served under `/vad/`).
- `audio/noise.ts` (pure): RMS dBFS per frame; floor = mean of frames with p < 0.3 during the first second, then an EMA with τ = 2 s. `quiet` < −50 ≤ `moderate` ≤ −35 < `noisy`. `noisy` adds 0.1 to the threshold, raises min speech to 200 ms and shows the hint.
- `audio/VoiceSession.ts`: maps events to reducers: `pushAudio(sessionId, phraseId, seq, pcm16, final)`, `endTurn` then `reportNoise(floor)` once per turn, `interrupt` on barge-in (local playback is flushed at once). Calls `markPlayed` when each sentence starts.
- `audio/PlaybackQueue.ts` + `playbackLogic.ts`: 24 kHz PCM16 from `audio_out`, strictly by `idx` within the current utterance (out-of-order blocks wait; a missing index is skipped after 6 s or when its sentence is `dropped`), silence trimmed (`TRIM_SILENCE_LEVEL`), `FADE_MS` fades, `SENTENCE_PAUSE_MS` after each sentence, gapless scheduling. `playback_flush` or barge-in stops it at once; flushed utterances never play again.

VAD assets (Silero and Smart Turn models, worklet, ORT wasm + glue) are served under `/vad/` from `node_modules` by a small Vite plugin (dev middleware; copied to `dist/vad/` on build), so everything works offline.

## Board (replaceable pack boundary)

`src/board/registry.tsx` maps kind name → renderer; renderers get the parsed content, the reveal state and (gap tasks only) the answer state with a `submit` callback that is absent in the observer. An unknown kind gets a neutral fallback (title + raw JSON). Kind names appear only inside `src/board/`; phase labels come from the pack (`getPhase`).

Reveal sync (`board/reveal.ts`): an item tagged `(utteranceId, sentenceIdx)` shows when that sentence starts playing (session tab: local playback; observer: status `played`), untagged (`0`) items show immediately, and everything shows once the utterance is over. `worked_steps` reveals one step per sentence played after it appeared.

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
| `learner-list`, `learner-item` | `data-learner-id`, `data-learner-name` | pick user (click → session or start form) |
| `learner-active-session`, `learner-new-session` | | pick user |
| `create-user-form`, `create-name`, `create-age`, `create-grade`, `create-style`, `create-submit` | | pick user |
| `start-form`, `task-text`, `photo-input`, `start-session` | | pick user, after choosing a learner without an active session |
| `session-screen` / `observer-screen` | `data-session-id` | |
| `learner-name`, `session-code` | `data-session-id` | header |
| `phase-indicator` | `data-phase` (id), text = pack label | |
| `topic-indicator` | `data-category`, `data-concept` | |
| `turnstate-indicator` | `data-state` | |
| `noise-indicator` | `data-noise` = quiet / moderate / noisy, `data-floor` (dBFS) | session, miccheck |
| `noise-hint`, `headphones-hint` | | session |
| `start-talking`, `stop-talking`, `end-session`, `open-observer` | | session |
| `mic-state` | `data-listening`, `data-speaking`, `data-tutor-audio` | session, while talking |
| `task-display`, `session-photo-input`, `photo-state` | `data-state` | session |
| `captions` | | |
| `caption-student` | `data-ref` = turn idx; children `caption-phrase` with `data-id` (phraseId), `data-status` | |
| `caption-tutor` | `data-ref` = utteranceId; children `caption-sentence` with `data-id` (idx), `data-status` | |
| `board` | | |
| `board-item` | `data-kind`, `data-idx`, `data-id`, `data-revealed` = true / false (hidden items stay in the DOM with `hidden`), `data-known` | |
| `worked-step`, `gap-choice`, `gap-input`, `gap-submit`, `gap-state` (`data-state` = open / correct / wrong), `board-fallback` | | inside board items |
| `debug-panel`, `metrics-table`, `metrics-row` | row: `data-turn`, `data-utterance`, `data-first-audio-ms`, `data-first-playback-ms` (ms after turn end) | |
| `local-latency` | | tab-local turn end → first audio heard |
| `event-log` | | |
| `overview-table`, `overview-row` (`data-session-id`, `data-phase`, `data-turn-state`), `overview-observe` | | overview |
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
    boardItems: {id, idx, kind, visible, utteranceId, sentenceIdx, answerState}[],
    observing, flushes,          // observer only
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
| `audio.play_start` / `audio.play_end` | utteranceId, idx |
| `audio.dropped` / `audio.empty` | utteranceId, idx |
| `audio.flush` | utteranceId (0 = current), reason = playback_flush / barge_in / destroy, stopped |
| `latency.turn_end_to_first_audio` | ms, utteranceId |
| `observer.flush` | utteranceId |
| `ui.*` | pick_learner, start_talking, start_failed, photo_failed, render_error |
