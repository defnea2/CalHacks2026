# Voice Math Tutor

A voice math tutor for students aged 8–12. Real-time voice (speech-to-text → LLM → text-to-speech), lesson phases, a shared board, and learner memory. Everything runs locally on top of SpacetimeDB.

Test users only. Never use real children's data.

## Layout

| Folder | What |
| --- | --- |
| `spacetimedb/` | SpacetimeDB TypeScript module: tables, reducers, procedures (TTS, memory extraction), schedule jobs |
| `worker/` | Node process: LLM streaming (OpenRouter), tool routing, streaming STT (Cartesia ink-2) |
| `client/` | Local web client (Vite + React) |
| `shared/` | Pure TS shared by all three: types, config, sentence chunker, speech normalizer, lesson pack |
| `shared/src/lesson/` | Replaceable lesson pack: phases, prompts, board kinds, taxonomy, content library |
| `e2e/` | Automated end-to-end tests (generated speech → fake microphone in headless Chrome) |

## Running locally

Requirements: Node 22+, pnpm, the `spacetime` CLI (2.13), and a root `.env` with `CARTESIA_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (see `.env.example`).

```bash
pnpm install
pnpm stdb:start            # terminal 1: local SpacetimeDB, data in ./.spacetime-data (git-ignored)
pnpm stdb:publish          # publishes the module, passes keys as module env
pnpm stdb:generate         # regenerates client + worker bindings
pnpm worker                # terminal 2
pnpm client                # terminal 3, open the printed URL
```

If your machine has a system HTTP proxy (macOS network settings), local tools need `NO_PROXY=127.0.0.1,localhost`. The scripts set it.

`.spacetime-data/` stays local. It contains the module env, including the API keys, as plain bytes in its commit log and snapshots, so it must never be pushed.

## Why a worker exists

SpacetimeDB runs the lesson logic, the state, speech synthesis and memory extraction. But a procedure's `ctx.http.fetch` is synchronous and returns the complete response, so it can't consume a token-by-token LLM stream. Async procedures are proposed in SpacetimeDB issue #4697 but not available. The worker therefore does LLM streaming and tool routing (plus streaming STT, see check #3). It decides nothing about lesson flow: every phase change, board item and turn transition is validated by SpacetimeDB reducers.

The worker connects as a normal SpacetimeDB client with its own identity, registered as `agent`. Client and worker never talk to each other directly.

## First checks (spikes, 2026-10-24)

| # | Check | Result | Decision |
| --- | --- | --- | --- |
| 1 | Several `ctx.http.fetch` calls and several `withTx` commits in one procedure run | ✅ 3 fetches + 3 committed transactions in one run | Procedures may chain calls |
| 2 | A procedure waiting 3 s on a request doesn't delay other clients' reducer calls | ✅ Reducer round trip p50 9.2 ms / max 15 ms during a 3 s procedure (idle: 8.2 / 17 ms) | TTS stays in procedures |
| 3 | Cartesia one-shot endpoints for the latest models | TTS ✅ `sonic-3.6` via `POST /tts/bytes`, raw `pcm_s16le` 24 kHz: first byte 0.37–0.54 s, full sentence 1.2–1.5 s. STT ❌ for the latest model: `ink-2` (released 2026-09-17) is streaming-only; batch `POST /stt` accepts only the older `ink-whisper` and took 2.8–3.9 s for 4 s of audio. `ink-2` over the websocket returned the final transcript **385 ms after `finalize`** | **Fallback:** STT runs in the worker, streaming `ink-2` (`wss://api.cartesia.ai/stt/websocket`), behind the same `SttProvider` interface. Audio still flows client → `pushAudio` → SpacetimeDB; the module emits each chunk as an `audio_in` event row that the worker forwards. The worker reports text via `phraseTranscribed`; turn closing stays in the module |
| 4 | Module secrets via environment variables on the local server | ✅ `schema(..., { env })` + `ctx.env.X`; values passed as shell variables at `spacetime publish` | Used for `CARTESIA_API_KEY`, `OPENROUTER_API_KEY`, `AGENT_SECRET`. Note: stored in the data dir |
| 5 | `openai/gpt-5.6-luna` streams tool calls and accepts images | ✅ Tool-call deltas stream correctly; image input works. First token 1.2–2.3 s by default, 1.0–1.8 s with `reasoning.effort = none` | `LLM_REASONING_EFFORT=none` by default |
| 6 | Round trip client → SpacetimeDB → worker → SpacetimeDB → client | ✅ p50 14.2 ms, max 22.5 ms (local) | — |

Cartesia API version: `2026-08-14`. Tutor voice "Parker" (`30894953-…`), test-student voice "Daisy" (very young, `32b3f3c5-…`).
