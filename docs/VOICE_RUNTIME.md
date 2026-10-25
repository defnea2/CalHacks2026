# Voice Math Tutor

For the integrated animated canvas and voice-free preview, see [VOICE_CANVAS.md](VOICE_CANVAS.md).

A voice math tutor for students aged 8–12. Real-time voice (speech-to-text → LLM → text-to-speech), lesson phases, a shared board, and learner memory. Everything runs locally on top of SpacetimeDB.

Test users only. Never use real children's data.

## Layout

| Folder | What |
| --- | --- |
| `spacetimedb/` | SpacetimeDB TypeScript module: tables, reducers, procedures (TTS, memory extraction), schedule jobs |
| `worker/` | Node process: LLM streaming (OpenRouter) and tool routing |
| `stt-proxy/` | One-file Node server: Cartesia batch STT interface on top of the ink-2 websocket (see *STT decision*) |
| `client/` | Local web client (Vite + React) |
| `shared/` | Pure TS shared by all three: types, config, sentence chunker, speech normalizer, lesson pack |
| `shared/src/lesson/` | Replaceable lesson pack: phases, prompts, board kinds, taxonomy, content library |
| `e2e/` | Automated end-to-end tests (generated speech → fake microphone in headless Chrome) |

## Running locally

Requirements: Node 22+, pnpm, the `spacetime` CLI (2.13), and a root `.env` with `CARTESIA_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (see `.env.example`).

```bash
pnpm install
pnpm dev:voice             # everything below in one command (add -- --clear to reset the DB)

# or step by step:
pnpm stdb:start            # terminal 1: local SpacetimeDB, data in ./.spacetime-data (git-ignored)
pnpm stdb:publish          # publishes the module, passes keys as module env
pnpm stdb:generate         # regenerates client + worker bindings
pnpm stt-proxy             # terminal 2: batch STT -> ink-2 websocket on 127.0.0.1:8787
pnpm worker                # terminal 3
pnpm client                # terminal 4, open the printed URL
```

If your machine has a system HTTP proxy (macOS network settings), local tools need `NO_PROXY=127.0.0.1,localhost`. The scripts set it.

`.spacetime-data/` stays local. It contains the module env, including the API keys, as plain bytes in its commit log and snapshots, so it must never be pushed.

## Why a worker exists

SpacetimeDB runs the lesson logic, the state, speech synthesis and memory extraction. But a procedure's `ctx.http.fetch` is synchronous and returns the complete response, so it can't consume a token-by-token LLM stream. Async procedures are proposed in SpacetimeDB issue #4697 but not available. The worker therefore does LLM streaming and tool routing only. It decides nothing about lesson flow: every phase change, board item and turn transition is validated by SpacetimeDB reducers.

The worker connects as a normal SpacetimeDB client with its own identity, registered as `agent`. Client and worker never talk to each other directly.

## First checks (spikes, 2026-10-24)

| # | Check | Result | Decision |
| --- | --- | --- | --- |
| 1 | Several `ctx.http.fetch` calls and several `withTx` commits in one procedure run | ✅ 3 fetches + 3 committed transactions in one run | Procedures may chain calls |
| 2 | A procedure waiting 3 s on a request doesn't delay other clients' reducer calls | ✅ Reducer round trip p50 9.2 ms / max 15 ms during a 3 s procedure (idle: 8.2 / 17 ms) | TTS stays in procedures |
| 3 | Cartesia one-shot endpoints for the latest models | TTS ✅ `sonic-3.6` via `POST /tts/bytes`, raw `pcm_s16le` 24 kHz: first byte 0.37–0.54 s, full sentence 1.2–1.5 s. STT ❌ for the latest model: `ink-2` (released 2026-09-17) is websocket-only; batch `POST /stt` accepts only the older `ink-whisper` (2.8–3.9 s for 4 s of audio). `ink-2` over the websocket: final transcript 385 ms after `finalize` when streamed in real time | STT stays in SpacetimeDB (`transcribePhrase` procedure) and calls a local **stt-proxy** with Cartesia's batch interface, which forwards to `ink-2` over the websocket. Measured through the proxy: 1.07–1.85 s for a 4 s phrase sent in one batch. See *STT decision* |
| 4 | Module secrets via environment variables on the local server | ✅ `schema(..., { env })` + `ctx.env.X`; values passed as shell variables at `spacetime publish` | Used for `CARTESIA_API_KEY`, `OPENROUTER_API_KEY`, `AGENT_SECRET`. Note: stored in the data dir |
| 5 | `openai/gpt-5.6-luna` streams tool calls and accepts images | ✅ Tool-call deltas stream correctly; image input works. First token 1.2–2.3 s by default, 1.0–1.8 s with `reasoning.effort = none` | `LLM_REASONING_EFFORT=none` by default |
| 6 | Round trip client → SpacetimeDB → worker → SpacetimeDB → client | ✅ p50 14.2 ms, max 22.5 ms (local) | — |

Cartesia API version: `2026-08-14`. Tutor voice "Parker" (`30894953-…`), test-student voice "Daisy" (very young, `32b3f3c5-…`).

## STT decision: SpacetimeDB calls Cartesia through a local batch proxy

**Problem.** The spec wants speech-to-text inside SpacetimeDB: a scheduled `transcribePhrase` procedure sends one phrase's audio to Cartesia in one request. Cartesia's latest STT model, `ink-2`, is only available over a websocket (`wss://api.cartesia.ai/stt/websocket`). SpacetimeDB procedures can't open websockets yet; `ctx.http.fetch` makes one synchronous HTTP request.

**Decision.** Keep STT in SpacetimeDB, exactly as it would work with a batch `ink-2` endpoint, and add `stt-proxy/server.ts`, a single-file Node server that:

- exposes the same interface as Cartesia's batch endpoint: `POST /stt?encoding=pcm_s16le&sample_rate=16000`, `Authorization: Bearer <key>`, `Cartesia-Version`, multipart `file` / `model` / `language`;
- forwards the request as is: the whole buffer is sent through an `ink-2` websocket in 100 ms frames in one go, followed by `finalize`; it waits for `flush_done`;
- answers with Cartesia's batch response shape (`{type: "transcript", text, language, duration, request_id}`);
- keeps two warm websockets per key and format, so the ~0.7 s connect time is hidden.

**SpacetimeDB refuses private addresses.** SpacetimeDB 2.13 blocks procedure HTTP to loopback and private IPs (`refusing to connect to private or special-purpose addresses`). This is built in; `config.toml` only has `[module-http] enabled`. So the proxy must run on a **public HTTPS host**. For that there is `stt-proxy/stt-proxy.php`: the same contract as `server.ts`, one dependency-free PHP file (PHP ≥ 7.4 + openssl), with a minimal TLS websocket client. It has no warm socket pool, because PHP runs per request, so each call pays the websocket connect time (~0.5–0.8 s).

Deploy:
1. Upload `stt-proxy/stt-proxy.php` to the webhost.
2. Check it: `curl https://your.host/stt-proxy.php/health` → `{"ok":true}`.
3. Publish with `STT_BASE_URL=https://your.host/stt-proxy.php CARTESIA_STT_MODEL=ink-2 pnpm stdb:publish`, or put both in `.env`. The module calls `${STT_BASE_URL}/stt`, which reaches the file via `PATH_INFO`.
4. If the host strips the `Authorization` header (some Apache/CGI setups), add to `.htaccess`: `RewriteEngine On` and `RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]`.

The proxy uses the caller's own Cartesia key from the `Authorization` header and stores nothing, so a public URL doesn't expose our key. Verified locally in `php:8.3-cli` against `stt-proxy/test/fake-cartesia.mjs` (`STT_PROXY_UPSTREAM=tcp://…`): handshake with forwarded key and query, 85 masked 100 ms frames (all bytes), ping/pong, non-final deltas skipped, a 70 KB frame (64-bit length), `flush_done`, and the batch response shape. The real Cartesia hop could not be tested from the container (no outbound network in the local VM).

**Until the PHP proxy is online**, publish with `STT_BASE_URL=https://api.cartesia.ai CARTESIA_STT_MODEL=ink-whisper` (Cartesia's own batch endpoint, older model). First live voice turn with this setup (2026-10-25), measured from turn end: STT done +0.45 s, LLM first token +1.74 s, first sentence +1.99 s, first audio +2.77 s, playback +2.83 s.

The module only knows a base URL (`STT_BASE_URL`, default `http://127.0.0.1:8787`). The API key stays in the module env and passes through in the `Authorization` header. When SpacetimeDB gets websockets or async procedures (issue #4697), or Cartesia offers `ink-2` in batch, set `STT_BASE_URL=https://api.cartesia.ai` and delete `stt-proxy/`. Nothing else changes.

**Why not stream from the worker?** That was the spec's fallback. It works (385 ms after `finalize`), but it moves a SpacetimeDB responsibility into the worker. The proxy keeps the architecture as close as possible to what SpacetimeDB would do natively. Phrases are transcribed while the student is still talking, so only the last phrase's transcription falls inside the turn-end wait.

## Running on Maincloud (hosted SpacetimeDB)

Local stays the default. To use SpacetimeDB's hosted cloud instead (web dashboard included):

```bash
spacetime login                                   # once, opens the browser
SPACETIME_SERVER=maincloud SPACETIME_DB=<unique-name> \
  STT_BASE_URL=https://<your-host>/stt-proxy.php CARTESIA_STT_MODEL=ink-2 \
  node scripts/publish.mjs                        # or STT_BASE_URL=https://api.cartesia.ai CARTESIA_STT_MODEL=ink-whisper
SPACETIME_URI=wss://maincloud.spacetimedb.com SPACETIME_DB=<unique-name> pnpm worker
pnpm client   # open http://127.0.0.1:5175/?uri=wss://maincloud.spacetimedb.com&db=<unique-name>
```

Notes: database names on Maincloud are global, so pick a unique one. The module env (API keys) is then stored by Maincloud. Every hop (audio chunks up, sentences and audio down, worker ↔ database) crosses the internet, so expect more latency than locally, and more sensitivity to an unstable connection. Procedures on Maincloud can reach public hosts, so the PHP proxy (or Cartesia directly) works; localhost does not.
