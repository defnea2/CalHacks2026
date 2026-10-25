# Deploy runbook: Maincloud + Cloudflare Pages (CLOUD_PLAN Part A)

**Status: deployed 2026-10-25** (Maincloud database `fibonacci-demo`, Cloudflare Pages project
`fibonacci` at <https://fibonacci-26f.pages.dev/>). See [Current deployment](#current-deployment)
for the exact state, commands and measured numbers. The local stack (`local` server on
`127.0.0.1:3000`, database `voice-tutor`) is not changed by any step below.

What runs where after this runbook:

| Piece | Where | Talks to |
| --- | --- | --- |
| Module (database `fibonacci-demo`) | SpacetimeDB Maincloud | Cartesia (STT/TTS), Anthropic (memory, dashboard, sims) |
| Worker (lesson planner) | your laptop, `pnpm --filter worker start` | `wss://maincloud.spacetimedb.com` + Anthropic (outbound only, NAT is fine) |
| Client (static files) | Cloudflare Pages, project `fibonacci` | `wss://maincloud.spacetimedb.com` (baked in at build time) |

Markers: **[USER]** needs a decision, an account or a credential from you. Every other step is a
command to run as written. `fibonacci-demo` is used as the database name throughout: replace it
everywhere if you pick another one.

> The spacetime CLI's own default server on this machine is **maincloud**. The repo scripts never
> rely on it: they always pass an explicit `--server` (`SPACETIME_SERVER`, default `local`). When
> you type raw `spacetime` commands, always pass `--server local` or `--server maincloud`.

---

## 0. Before you start: dry runs (no network)

Every script prints its target first and refuses a non-local server unless you confirm with
`--yes-remote`. `--dry-run` prints the exact `spacetime` commands and runs nothing (seed-demo then
assumes an empty database). Try them first:

```bash
export SPACETIME_SERVER=maincloud SPACETIME_DB=fibonacci-demo
export AGENT_SECRET=dry-run-placeholder STT_BASE_URL=https://api.cartesia.ai CARTESIA_STT_MODEL=ink-whisper
node scripts/publish.mjs --dry-run
node scripts/seed-demo.mjs --dry-run
node scripts/simulate.mjs --dry-run --preset A
unset SPACETIME_SERVER SPACETIME_DB AGENT_SECRET STT_BASE_URL CARTESIA_STT_MODEL
```

`tests/deploy-scripts.test.ts` (root `pnpm test`) checks the same output.

| Flag | Meaning |
| --- | --- |
| `--yes-remote` | Required for any write to a non-local server (publish, seed-demo, simulate) |
| `--yes-delete-remote-data` | Additionally required for `publish.mjs --clear` on a non-local server |
| `--dry-run` | Print target, module env key names and commands; run nothing |

## 1. Account and database name [USER]

1. **[USER]** Decide: Maincloud Free or Pro (CLOUD_PLAN §13 Q1; Free pauses after a week idle).
2. **[USER]** Log the CLI in with the account that should own the database:
   ```bash
   spacetime login            # opens the browser (GitHub/Google)
   spacetime login show       # note the identity
   ```
3. **[USER]** Choose the database name. Names are global on Maincloud; `fibonacci-demo` may be
   taken. The publish in step 3 fails clearly if it is.

## 2. Secrets for the cloud [USER]

The module env is uploaded to Maincloud with the module. Use a **new** `AGENT_SECRET` for the
cloud (publish.mjs refuses the laptop's `.env.local` value):

```bash
export AGENT_SECRET=$(openssl rand -hex 24)    # keep it: the worker and seed-demo need the same value
export INSIGHTS_KEY=$(openssl rand -hex 16)    # shared deployment: gates the insights view (ARCHITECTURE §8)
```

**[USER]** Store both somewhere safe (password manager). Optionally use a separate
`CARTESIA_API_KEY` / `ANTHROPIC_API_KEY` for the cloud (usage attribution): export them in the
shell, which overrides `.env`.

## 3. Publish the module to Maincloud

```bash
SPACETIME_SERVER=maincloud SPACETIME_DB=fibonacci-demo \
STT_BASE_URL=https://api.cartesia.ai CARTESIA_STT_MODEL=ink-whisper \
node scripts/publish.mjs --yes-remote
```

It prints `target: server=maincloud db=fibonacci-demo [REMOTE]` and the module env key names before
publishing. **Module env passed** (from the shell, else `.env` / `.env.local`):

| Always | Only when set |
| --- | --- |
| `CARTESIA_API_KEY`, `AGENT_SECRET`, `OPENROUTER_API_KEY` (may be empty), `OPENROUTER_EXTRACTION_MODEL` (may be empty) | `ANTHROPIC_API_KEY`, `ANTHROPIC_EXTRACTION_MODEL`, `MEMORY_PROVIDER`, `STT_BASE_URL`, `CARTESIA_STT_MODEL`, `CARTESIA_TTS_MODEL`, `CARTESIA_VOICE_ID`, `TTS_SAMPLE_RATE`, `MEMORY_EVERY_N_TURNS`, `SIM_MAX_TURNS`, `DASHBOARD_INTERVAL_S`, `DASHBOARD_EFFORT`, `LESSON_ARC`, `INSIGHTS_KEY`, `RETENTION_IMAGE_MIN`, `RETENTION_DAYS` |

Required for a remote server: `CARTESIA_API_KEY`; `ANTHROPIC_API_KEY` (or `OPENROUTER_API_KEY` +
`OPENROUTER_MODEL`); a public `STT_BASE_URL` (procedures cannot reach localhost); a shell
`AGENT_SECRET` that differs from `.env.local`.

**[USER] decision for STT:** `https://api.cartesia.ai` + `ink-whisper` (direct), or your public PHP
proxy + `ink-2` (`STT_BASE_URL=https://<host>/stt-proxy.php CARTESIA_STT_MODEL=ink-2`).

Check (CLOUD_PLAN F6, the highest-risk unknown: is module env honoured on Maincloud?):

```bash
spacetime list --server maincloud                          # the database is listed
spacetime logs --server maincloud fibonacci-demo -n 50     # no "missing key" errors after step 7
```

Republishing later (code change) is the same command; it hot-swaps the module. To wipe the cloud
data (cannot be undone): add `--clear --yes-delete-remote-data`.

## 4. Seed the demo users

```bash
SPACETIME_SERVER=maincloud SPACETIME_DB=fibonacci-demo node scripts/seed-demo.mjs --yes-remote
```

Uses the shell `AGENT_SECRET` from step 2. Note: `register_agent` makes **the logged-in CLI identity
(the owner) an agent** of the cloud database, so it can write the seed memory. That is intended
for the owner; don't run it from a shared machine. `init` already loads the lesson library and the
20 simulated students, so there is no data migration (CLOUD_PLAN A4).

Optional class simulation: `SPACETIME_SERVER=maincloud SPACETIME_DB=fibonacci-demo node scripts/simulate.mjs --preset A --yes-remote`
(needs the worker, step 5).

## 5. Worker on the laptop

```bash
SPACETIME_URI=wss://maincloud.spacetimedb.com SPACETIME_DB=fibonacci-demo \
AGENT_SECRET=$AGENT_SECRET AGENT_TOKEN_FILE=worker/.agent-token.maincloud \
pnpm --filter worker start
```

- `AGENT_TOKEN_FILE` keeps the cloud identity apart from the local one (`worker/.agent-token`).
  `worker/.agent-token*` is git-ignored. Losing the file only means the worker registers a new
  identity on the next start (same `AGENT_SECRET`).
- Expect `connected to wss://maincloud.spacetimedb.com/fibonacci-demo`, `registered as agent`,
  `subscribed`. The SDK accepts `wss://` and `https://` alike (it rewrites `https:` to `wss:`;
  checked in `spacetimedb@2.13.0`, `index.browser.mjs`).
- Keep the laptop awake for the demo. Don't run a second worker against the same database.

## 6. Client build and Cloudflare Pages

Build with the cloud database baked in (Vite reads `VITE_*` at build time; `?uri=` / `?db=` URL
params still override at runtime):

```bash
VITE_SPACETIME_URI=wss://maincloud.spacetimedb.com VITE_SPACETIME_DB=fibonacci-demo \
pnpm --filter client build
node client/scripts/check-dist.mjs        # assets, sizes, _headers, baked URI/DB; no network
```

What the build contains (checked by `check-dist.mjs`):

- Relative URLs (`base: './'`): `dist/` works from any root or sub-path, no SPA fallback needed
  (the app routes by query string only, so no `_redirects`).
- `dist/vad/`: Silero v5 + legacy, Smart Turn v3.2 (8.3 MiB) + its licence, the VAD worklet, the
  ONNX Runtime wasm + glue. The 27 MiB JSEP (WebGPU) runtime is left out: it is never loaded, and
  it is over Pages' 25 MiB per-file limit.
- `dist/_headers` (from `client/public/_headers`): `Content-Type` for `.wasm` / `.onnx` / `.mjs`,
  long caching for hashed `assets/`, `no-cache` for `index.html`, 1 day for `vad/`. **No
  COOP/COEP**: ONNX Runtime runs with `numThreads = 1`, so cross-origin isolation is not needed.

Deploy (Cloudflare limits verified 2026-10-25: 25 MiB per file, 20,000 files on Free, 100
`_headers` rules):

```bash
npx wrangler login                                                     # [USER] once, browser
npx wrangler pages project create fibonacci --production-branch main --force   # [USER] once
npx wrangler pages deploy client/dist --project-name fibonacci --branch main
```

wrangler 4.15x delegates `pages project create` to Workers, which fails in a pnpm workspace root;
`--force` (once, on create only) creates a classic Pages project. Run wrangler from `client/`. The
`fibonacci.pages.dev` subdomain was taken, so Pages assigned `fibonacci-26f.pages.dev`.

**[USER]** decisions: Cloudflare account, project name (`fibonacci` gives
`https://fibonacci.pages.dev`; it must be free), custom domain (Pages dashboard → Custom domains).
HTTPS comes with Pages, which `getUserMedia` (microphone) needs.

## 7. Smoke checks

1. `curl -sI https://fibonacci.pages.dev/vad/ort-wasm-simd-threaded.wasm | grep -i content-type`
   → `application/wasm`; same for `/vad/smart-turn-v3.2-cpu.onnx` → `application/octet-stream`.
2. Headless, with a fake microphone (creates a test learner `Smoke NNNNN` in the cloud database):
   ```bash
   pnpm --filter e2e gen-speech       # once, if e2e/fixtures/ is empty
   pnpm --filter e2e smoke:deployed https://fibonacci.pages.dev/
   ```
   Expect `entry connected`, `session N`, `mic on`, a transcribed student phrase, tutor sentences,
   and 200s with the right content types for `vad/*`.
3. **[USER]** On a phone over LTE: open the Pages URL, allow the microphone, start a lesson, talk.
4. Fill in the Maincloud column of CLOUD_PLAN §A.3 from the debug panel (`turn_metrics`).

Verified locally (2026-10-25): the same build served by `python3 -m http.server` from the root and
from a sub-path (`/dist/`), against a local test database: entry connected, session started, STT
transcribed the fixture, the worker answered with a full lesson (4–5 beats).

### E2E against the cloud

The full harness (`pnpm test:e2e`) is still local only: it publishes its own database with
`--clear`, starts its own worker and Vite client, and reads server state with
`spacetime sql --server local`. It now forces `SPACETIME_SERVER=local`, `SPACETIME_URI` and
`VITE_SPACETIME_URI` to the local server, so a shell exporting the cloud values can't redirect it.
Pointing it at Maincloud (CLOUD_PLAN A7: `E2E_SPACETIME_URI` / `E2E_SPACETIME_DB`, skip publish and
the local worker, `--server maincloud` reads) is **not implemented**; `smoke:deployed` above is the
interim end-to-end check.

## 8. Rollback

- The local stack is untouched: `pnpm dev:voice` (or `node scripts/dev.mjs`) works as before.
- Point a browser back to local: `?uri=ws://127.0.0.1:3000&db=voice-tutor`, or rebuild the client
  without `VITE_*`.
- Stop the cloud worker (Ctrl+C).
- Pages: roll back to an earlier deployment in the dashboard, or delete the project.
- **[USER]** The Maincloud database can stay (Free pauses it when idle) or be deleted:
  `spacetime delete fibonacci-demo --server maincloud` (cannot be undone).

## Current deployment

As of 2026-10-25 16:10 UTC (branch `night/maincloud-deploy`).

| Piece | Value |
| --- | --- |
| Maincloud database | `fibonacci-demo` (owner = the logged-in CLI identity `c200657a…`), Free plan |
| Database identity | `c200b332ee7a2cef0cb77fd41083155a9189d2c80bd2cf137aa7cd27b9c0b26b` |
| Module URI | `wss://maincloud.spacetimedb.com` (worker and client) |
| STT | Cartesia direct: `STT_BASE_URL=https://api.cartesia.ai`, `CARTESIA_STT_MODEL=ink-whisper` |
| Client | Cloudflare Pages project `fibonacci`, <https://fibonacci-26f.pages.dev/> (production branch `main`) |
| Worker | **not running persistently**: start it on the laptop (below) |
| Secrets | `AGENT_SECRET`, `INSIGHTS_KEY` (+ the STT vars) in `/Users/leanderneubronner/Desktop/CalHacks2026/.env.maincloud` (ignored via `.env.*`, mode 600). API keys come from the main checkout's `.env`. Never commit or print them. |
| Seeded | demo students Ava Chen, Sam Rivera, Priya Patel; teachers Ms. Park, Mr. Alvarez; 20 sim profiles from `init` |
| Test data | learners `Smoke NNNNN` and sessions 1–10 from smoke runs; class 1 (preset A, 4 sims, ended) |

**Module env is honoured on Maincloud (CLOUD_PLAN F6: verified).** `register_agent` compares
against `ctx.env.AGENT_SECRET` and succeeded; STT and TTS (Cartesia key) and the sim turns, memory
and dashboard (Anthropic key) all worked. No secret-table workaround is needed.

### Commands

All from the repository root (main checkout). Load the cloud secrets and API keys into the shell
first (nothing is printed):

```bash
set -a; source .env; source .env.maincloud; set +a
export SPACETIME_SERVER=maincloud SPACETIME_DB=fibonacci-demo
```

Worker (keep the laptop awake; only one worker per database):

```bash
SPACETIME_URI=wss://maincloud.spacetimedb.com AGENT_TOKEN_FILE=worker/.agent-token.maincloud \
pnpm --filter worker start
# expect: connected to wss://maincloud.spacetimedb.com/fibonacci-demo, registered as agent, subscribed
```

A relative `AGENT_TOKEN_FILE` is resolved from the repo root since this branch. Before, the
`pnpm --filter` cwd `worker/` made the write fail silently (`worker/worker/` does not exist), so
the worker registered a fresh identity on every start.

Republish the module after a code change (hot-swap, keeps data): `node scripts/publish.mjs --yes-remote`.

Rebuild and redeploy the client:

```bash
VITE_SPACETIME_URI=wss://maincloud.spacetimedb.com VITE_SPACETIME_DB=fibonacci-demo pnpm --filter client build
node client/scripts/check-dist.mjs
(cd client && npx wrangler pages deploy dist --project-name fibonacci --branch main --commit-dirty=true)
```

The upload of 83 files took about 5 minutes from this laptop. To serve the same build locally
instead (any free port, not 5175): `python3 -m http.server 5397 --bind 127.0.0.1 -d client/dist`.

Smoke (needs the worker): `pnpm --filter e2e smoke:deployed https://fibonacci-26f.pages.dev/ [wav]`
(`e2e/fixtures/` is not in git; generate it with `pnpm --filter e2e gen-speech` or pass a wav path).

Class simulation: `node scripts/simulate.mjs --yes-remote --preset A --n 4`, end it with
`node scripts/simulate.mjs --end --yes-remote`. It prints a `127.0.0.1:5175` dashboard link; for
the cloud open `https://fibonacci-26f.pages.dev/?class=<id>` instead.

Raw SQL: run `spacetime sql` **with `--no-config`, or outside the repo**. Inside the repo the CLI
reads `spacetime.json` and queries `voice-tutor` instead (on maincloud: "failed to find database
`voice-tutor`"):
`spacetime sql --no-config --server maincloud fibonacci-demo "SELECT name FROM learner"`.

### Checks done

- Publish, seed (`SELECT name FROM learner` lists the 3 demo students), worker registered as agent.
- `check-dist.mjs` ok (84 files, baked URI/DB). Pages headers: `.wasm` `application/wasm`, `.onnx`
  `application/octet-stream`, `.mjs` `text/javascript`, `index.html` `no-cache`, `vad/` 1 day.
- `smoke:deployed` against a local static serve of the build: 5 of 7 runs green. The first 2 (just
  after the database was created) waited 20 s for the session screen and failed, although the
  session row existed on the server. All later runs passed; not reproduced. Against
  <https://fibonacci-26f.pages.dev/>: 2 of 2 green (session, mic, STT transcript, 3+ tutor sentences).
- Simulated class (preset A, 4 students): openings, sim turns, a dashboard summary and 2 clusters
  within 35 s; ended cleanly.

### Measured (Maincloud, worker on the laptop, `turn_metrics`)

| Metric | Maincloud | Local (latency-internal) |
| --- | --- | --- |
| Network RTT laptop to maincloud (TCP connect) | 67–117 ms | n/a |
| Reducer RTT, browser (`pushAudio`, 5 KB) | 136–290 ms, about 230 ms median (n=8) | 8 / 14 ms |
| Reducer RTT, browser (`endTurn`, `reportNoise`) | about 105 ms | n/a |
| Voice turn end to first audio (n=6, 4 preemptive) | p50 2.8 s, range 2.16–3.46 s | p50 about 2.75–3.4 s |
| Voice turn end to first playback | p50 3.2 s, range 2.49–3.82 s | n/a |
| Session start to opening audio (lead-in TTS, n=7) | p50 0.80 s, range 0.55–1.41 s | n/a |
| Session start to opening playback | p50 1.15 s, range 0.87–2.11 s | n/a |
| Sim (text) turn end to first sentence (n=9) | p50 1.54 s, range 1.44–3.01 s | n/a |
| Topic prefetch, 4 sims at once | 139 / 175 / 266 / 392 ms | n/a |
| Pages: Smart Turn model fetch (8.3 MiB, cold) | 1.3–2.0 s | about 40 ms (local serve) |

Turn end to first audio is about the same as local, as predicted: the LLM hop is still laptop to
Anthropic. The staggered topic-prefetch times with 4 parallel sessions suggest procedures run one
at a time (about 100 ms each); no errors. One outlier: a turn whose STT returned "…" took 17.4 s to
first audio (stall watchdog path). The module log shows one benign `begin_lesson: utterance … is
not current` after a barge-in.

## Env vars at a glance

| Name | Used by | Where to set |
| --- | --- | --- |
| `SPACETIME_SERVER` | publish.mjs, seed-demo.mjs, simulate.mjs | shell (`local` default, `maincloud`) |
| `SPACETIME_DB` | publish/seed/simulate, worker | shell |
| `SPACETIME_URI` | worker | shell (`wss://maincloud.spacetimedb.com`) |
| `AGENT_SECRET` | module env, worker, seed-demo | shell (fresh for cloud) |
| `AGENT_TOKEN_FILE` | worker | shell (separate file for cloud) |
| `VITE_SPACETIME_URI`, `VITE_SPACETIME_DB` | client build | shell at build time |
| API keys, `STT_BASE_URL`, `INSIGHTS_KEY`, … | module env | `.env` or shell (table in step 3) |
