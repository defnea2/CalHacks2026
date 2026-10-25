# Services and libraries

Every external service and major library: what it is for, where it is used, how it is configured,
licence notes, and measured latency where we have numbers. Numbers come from
[latency-internal.md](latency-internal.md), [CLASSROOM.md](CLASSROOM.md), the README and
`client/models/README.md`; all were measured on 2026-10-24/25 on a MacBook against a local
SpacetimeDB 2.13, mostly over a phone hotspot. Architecture: [ARCHITECTURE.md](ARCHITECTURE.md).

Secrets live only in the root `.env` / `.env.local` (git-ignored). The worker reads them directly;
the module gets them as SpacetimeDB module env through `scripts/publish.mjs`. They never appear in
tables or in the client.

## External services

### Anthropic: Claude Haiku 5.5 (`claude-haiku-5-5`)

The one LLM of the product, used in two ways.

| Use | Where | How | Config |
| --- | --- | --- | --- |
| **Tutor replies (streaming)**: the lesson planner (default) and the tool loop | `worker/src/anthropic.ts` (`AnthropicProvider`), `worker/src/lesson.ts`, `worker/src/providers.ts` | `@anthropic-ai/sdk` Messages API, streaming text and tool-use deltas; the stable system prompt carries the prompt-cache breakpoint. Lesson mode: thinking disabled, `max_tokens` 4000, effort `LESSON_EFFORT` | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-haiku-5-5`), `LESSON_EFFORT` (default `low`), `ANTHROPIC_EFFORT` (tool mode, default `medium`), `ANTHROPIC_THINKING` (`disabled` default / `adaptive`), `REPLY_MODE` (`lesson` default / `tools`) |
| **Slant-lesson feedback** (`tutor_request` rows) | `worker/src/tutorRequests.ts` → `src/server/shearTutor.ts` | Non-streaming `fetch` to `/v1/messages` with a JSON schema, effort low, 30 s, max 4 at a time | same key and model |
| **Memory extraction + session summary** | `spacetimedb/src/memory.ts` → `spacetimedb/src/anthropic.ts` (`callAnthropicJson`) | Raw HTTP from a module procedure (`ctx.http.fetch`, `anthropic-version: 2023-06-01`), structured outputs (`output_config.format = json_schema`), answer read from the `text` blocks. No SDK: procedures can't run it | module env `ANTHROPIC_API_KEY`, `ANTHROPIC_EXTRACTION_MODEL`, `MEMORY_PROVIDER` (`anthropic` / `openrouter`), `MEMORY_EVERY_N_TURNS` (6). Extraction effort medium / 8000 tokens, summary low / 4000 |
| **Simulated students** | `spacetimedb/src/classroom.ts` `simStudentTurn` | Same `callAnthropicJson`, schema `{message}`, effort low, 2000 tokens | `SIM_MAX_TURNS` (8) |
| **Teacher dashboard** (summary + clusters) | `spacetimedb/src/classroom.ts` `refreshDashboard` | Same `callAnthropicJson`, one call per refresh with the whole class | `DASHBOARD_EFFORT` (low), `DASHBOARD_INTERVAL_S` (30) |

Measured:

- Voice turn end → first tutor audio, real Haiku + Cartesia: **p50 2.5 s** with the lesson planner
  (4.3 s with the tool loop); the authored opening plays after ~0.5 s (no LLM call).
- Thinking off is 0.3–0.5 s faster to the first token at effort low (`worker/src/env.ts`); the team
  measured adaptive thinking adding up to ~8 s in lesson mode (`worker/src/providers.ts`).
- Memory extraction 2.1–4.6 s (≈1.8–1.9k in / 350–830 out tokens), session summary 3.2 s.
- Simulated student message: median 1.5 s (0.8–2.8 s), ≈ $0.00018 per message.
- Dashboard refresh: 3–10 s at effort low for 6–8 students (≈ $0.0015 per refresh); medium was
  slower (8–15 s) and not more reliable, so low is the default.

Model notes: no `temperature`/`top_p`/`top_k` on this model; structured-output schemas need
`additionalProperties: false`, every field required, no numeric/length constraints.

### OpenRouter (fallback LLM)

| Where | What | Config |
| --- | --- | --- |
| `worker/src/llm.ts` (`OpenRouterProvider`) | Streaming chat + tool calls through the `openai` npm SDK with OpenRouter's base URL; used when `LLM_PROVIDER=openrouter` or no `ANTHROPIC_API_KEY` is set. First check: `openai/gpt-5.6-luna` streams tool calls and accepts images, first token 1.0–1.8 s with `reasoning.effort = none` | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `LLM_REASONING_EFFORT` (default `none`) |
| `spacetimedb/src/providers.ts` (`chatJson`) | Non-streaming JSON fallback for memory extraction (`MEMORY_PROVIDER=openrouter`) | module env `OPENROUTER_API_KEY`, `OPENROUTER_EXTRACTION_MODEL` |

`scripts/publish.mjs` and `scripts/dev.mjs` currently require `OPENROUTER_API_KEY` and
`OPENROUTER_MODEL` in `.env` even when Anthropic is used.

### Cartesia: TTS (`sonic-3.6`)

| | |
| --- | --- |
| Where | `spacetimedb/src/providers.ts` `synthesize` / `parseTtsSse`, called by the scheduled procedure `synthesizeSentence` (`voice_out.ts`) |
| How | `POST https://api.cartesia.ai/tts/sse` with `add_timestamps: true`; raw `pcm_s16le` 24 kHz; the full SSE body is parsed (procedures can't stream) into PCM + word timestamps, written as one `audio_out` event row per sentence. One retry, then the sentence is `dropped` |
| Word timestamps | Let the client place board items / reveals at a word (`markerPos`), not just a sentence start |
| Config | module env `CARTESIA_API_KEY`, `CARTESIA_TTS_MODEL` (default `sonic-3.6`), `CARTESIA_VOICE_ID` (default "Parker", a warm, child-friendly voice), `TTS_SAMPLE_RATE` (24000). API version `2026-08-14`. `MODULE_DEFAULTS.TTS_WORD_TIMESTAMPS=false` switches to `/tts/bytes` |
| Measured | One sentence (~3.5 s of audio) HTTP p50 532 ms, p95 805 ms (`/tts/bytes`); 4 parallel sessions p50 1007 ms. First check: first byte 0.37–0.54 s, full sentence 1.2–1.5 s |

### Cartesia: STT (`ink-2` via the proxy, `ink-whisper` batch fallback)

| | |
| --- | --- |
| Where | `spacetimedb/src/providers.ts` `transcribe`, called by the scheduled procedure `transcribePhrase` (`voice_in.ts`) once per phrase |
| How | `POST {STT_BASE_URL}/stt?encoding=pcm_s16le&sample_rate=16000`, multipart `file` / `model` / `language`, Cartesia's batch interface |
| `ink-2` | Cartesia's newest STT, websocket-only. Reached through `stt-proxy` (below). Websocket alone: final transcript 385 ms after `finalize`; through the proxy in one batch: 1.07–1.85 s for a 4 s phrase |
| `ink-whisper` | Cartesia's batch model, called directly with `STT_BASE_URL=https://api.cartesia.ai`. This is the setup of all E2E and latency runs: STT HTTP p50 292 ms, p95 671 ms (RTT-bound, no correlation with phrase length). Phrases are transcribed while the student keeps talking, so only the last phrase is on the critical path |
| Config | module env `STT_BASE_URL` (default `http://127.0.0.1:8787`, the local proxy), `CARTESIA_STT_MODEL` (default `ink-2`) |

### stt-proxy (our code, optional)

`stt-proxy/server.ts` (Node, `pnpm stt-proxy`, port 8787, 2 warm websockets per key/format) and
`stt-proxy/stt-proxy.php` (same contract for an ordinary PHP ≥ 7.4 host, no warm pool, +0.5–0.8 s
connect per call). Batch `/stt` in, `wss://api.cartesia.ai/stt/websocket` out, batch response back.
It forwards the caller's `Authorization` header and stores nothing. SpacetimeDB 2.13 refuses
procedure HTTP to loopback/private addresses, so in practice the module can only use a **public**
proxy (the PHP file) or Cartesia directly; see README "STT decision".

## Browser libraries

| Library | What for | Where | Notes / measured |
| --- | --- | --- | --- |
| **Silero VAD** via `@ricky0123/vad-web` 0.0.31 (ISC; Silero model MIT) | Speech probabilities per 32 ms frame (16 kHz). The package's own segmenting is disabled; our pure state machine does phrases, turns, barge-in | `client/src/audio/AudioCapture.ts`, `vadMachine.ts`, `noise.ts` | Inference p50 1.1 ms / p95 2.4 ms per frame, first frame 19 ms. Model selectable with `?vad_model=v5\|legacy`. Assets served from `/vad/` (offline-capable) |
| **Pipecat Smart Turn v3.2** (BSD-2-Clause, © Daily) | Semantic end-of-turn: P(turn complete) from the turn's audio, so turns end early when the sentence is complete and wait through "um" pauses | `client/src/audio/SmartTurn.ts`, `smartTurn.worker.ts`, `smartTurnFeatures.ts` (Whisper log-mel in TS); model `client/models/smart-turn-v3.2-cpu.onnx` (int8, 8.7 MB, committed with `LICENSE-smart-turn`, which must ship with it) | Load ~400 ms, features ~50 ms, inference ~220 ms, verdict ~270 ms after the phrase end. Turn end at ~608 ms of silence instead of ~928 ms when confident. `?smart_turn=0` disables it, `?smart_turn_threshold=`, `?smart_turn_min_silence_ms=` tune it |
| **onnxruntime-web** 1.30 (MIT) | Runs Silero and Smart Turn (wasm, 1 thread, SIMD) | via vad-web and the Smart Turn Web Worker | Served from `/vad/` by a small Vite plugin in `client/vite.config.ts` |
| **SpacetimeDB TypeScript SDK** (`spacetimedb` 2.13, ISC) | Client and worker connection, generated bindings, subscriptions, reducer calls | `client/src/stdb/*`, `client/src/module_bindings/`, `worker/src/stdb.ts`, `worker/src/module_bindings/` | Reducer round trip p50 ~8 ms; commit → subscriber ~7 ms. Client keeps confirmed reads on (subscription swaps), the worker turns them off (~5.5 ms saved per hop) |
| **React** 19 (MIT) | UI | `client/src`, `src/` | |
| **Vite** (MIT) + `@vitejs/plugin-react`, **Tailwind CSS** v4 (MIT) | Dev server (port 5175) and static build | `client/vite.config.ts` | `@tutor/visual` alias → `../src` |
| **KaTeX** 0.19 (MIT) | Math typesetting on the canvas, board and captions | team canvas (`src/presentation`), `client/src/board` | Board item render p50 ~8 ms |
| **Mafs** 0.21 (MIT) | Interactive geometry / coordinate visuals in the team canvas | `src/presentation/math/GeometryPicture.tsx` | |
| **motion** 14 (MIT) | Canvas and activity animation (keyframed cues) | `src/presentation/TeachingCanvas.tsx`, `src/visuals` | Respects reduced motion |
| **zod** 4 (MIT) | Team contracts and validators (lesson steps, checks, canvas commands); bundled into the SpacetimeDB module too | `teaching/src` (`@tutor/teaching`), `src/shared/contracts.ts` | |

## Server-side libraries

| Library | What for | Where |
| --- | --- | --- |
| **SpacetimeDB module SDK** (`spacetimedb/server`, server 2.13) | Tables, reducers, procedures (`ctx.http.fetch`, `ctx.withTx`), scheduled tables, event tables, module env | `spacetimedb/src/*` |
| **`@anthropic-ai/sdk`** 1.x (Apache-2.0) | Streaming Claude in the worker | `worker/src/anthropic.ts` |
| **`openai`** 6.x (Apache-2.0) | OpenRouter fallback (OpenAI-compatible streaming) | `worker/src/llm.ts` |
| **`ws`** 8 (MIT) | Websocket client of the STT proxy | `stt-proxy/server.ts` |
| **tsx**, **TypeScript**, **vitest** | Run the worker/proxy, typecheck, tests | all packages |
| **puppeteer-core** | E2E: headless Chrome with a fake microphone fed by generated child speech | `e2e/` |

## SpacetimeDB itself

- Local server `spacetime start` on `127.0.0.1:3000` (`pnpm stdb:start`, data in `./.spacetime-data`,
  git-ignored because it holds the module env in plain bytes). Database name `voice-tutor`.
- Module published with `pnpm stdb:publish` (`scripts/publish.mjs`), which passes keys as module env.
- Maincloud: supported by `SPACETIME_SERVER=maincloud` in `publish.mjs`, but whether to move there is
  the user's decision (README "Running on Maincloud").
- Measured internal overhead of the whole voice turn: ~100 ms (p50 101 ms). The procedure pool
  (~10 concurrent procedures on the test laptop; HTTP calls hold their slot) is the main
  scaling limit; see [ARCHITECTURE.md](ARCHITECTURE.md) section 10.
