# Deploy runbook: Maincloud + Cloudflare Pages (CLOUD_PLAN Part A)

**Status: prepared, not deployed.** The scripts and the client build are ready (branch
`night/maincloud-prep`). Nothing has been published to Maincloud and nothing has been deployed to
Cloudflare. The local stack (`local` server on `127.0.0.1:3000`, database `voice-tutor`) is not
changed by any step below.

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
npx wrangler pages project create fibonacci --production-branch main   # [USER] once
npx wrangler pages deploy client/dist --project-name fibonacci --branch main
```

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
