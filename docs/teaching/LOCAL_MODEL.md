# Real model, no API key

The development server now implements `POST /api/teaching/plan` using the machine's signed-in Codex CLI. It generates new teaching steps and compact mathematical commands for the learner's topic. [Compact math architecture and current verification](../COMPACT_MATH.md) describe the latest path. This is real model inference, not a lookup in the offline fixtures. Voice remains optional and is not connected.

## Run on your machine

1. Install the official Codex CLI if it is not already available.
2. Run `codex login` and sign in with ChatGPT. Check with `codex login status`.
3. In this repository, run `npm ci`, then `npm run dev`.
4. Open `http://127.0.0.1:5173/`, enter a question, and choose **Explore my question**.

No API key or `.env` file is required. The app uses your Codex allowance. Questions, recent lesson context and diagrams are sent to the model; this is not offline/local-weight inference. The three sample buttons explicitly use scripted offline lessons instead.

The CLI executable defaults to `codex` on PATH. If needed, set `TUTOR_CODEX_BIN` to its executable path before starting the server. `TUTOR_CODEX_MODEL` optionally selects a model available to your account; otherwise the CLI's own default is used. The bridge ignores user configuration while retaining normal CLI authentication, so a model override in your global Codex config is not automatically applied here. Environment overrides are server-owned, not accepted from browser requests.

The status label confirms the local bridge is reachable. It does not prove that authentication, model access or account allowance will succeed; those are checked by an actual generation request.

## Request lifecycle

1. The browser captures current planner and canvas context, retaining the director's context version.
2. The server parses a bounded request and discards caller-supplied system instructions, output schemas and phase permissions.
3. It computes allowed phases from validated lesson state and supplies the repository's teaching instructions and exact output schema.
4. A fresh `codex exec` receives the prompt over stdin. A small structured envelope carries a serialized compact math lesson; code expands it into the full teaching step.
5. The server assembles exact check wording into the final narration. Shared validation checks the output shape, teaching policy, referenced objects, mathematical constraints, independent-answer leakage rules and visual commands, including bounds for generated shapes. One invalid candidate may be repaired using the validation feedback; provider/authentication failures are not automatically retried.
6. The browser revalidates against its current planner revision and canvas version before presentation. A late response cannot overwrite newer learner work.
7. Text mode presents one beat immediately; Continue reveals later beats. Only the final beat enables a response. The next question/answer uses the actual scene, including learner edits.

The model generates data only. The app never evaluates generated JavaScript, HTML or shell commands. A diagram is limited to the current supported canvas vocabulary; requesting a new topic does not add new renderer capabilities.

## Local bridge boundaries

- Available through Vite development servers on ports 5173 and 5174. `vite preview` and a static production build do **not** include this endpoint.
- Loopback-only normal launch, local Host/Origin checks, JSON-only planning requests, a 1 MB body limit and a 120-second deadline.
- The server limits concurrent generation; a busy bridge returns HTTP 429; the browser waits up to 36 seconds for a free slot before showing a retry message. These waits do not start additional model generations. Cancel closes the request and terminates its CLI process.
- CLI runs are ephemeral, read-only, in a temporary working directory, with shell, plugins/apps, browser/computer use, agent delegation and web search disabled. No user config or project instructions are loaded.
- The server does not read, export, copy or commit Codex credential files. The CLI handles its existing login. Raw CLI diagnostics are not returned to the browser.
- Temporary schema/output files are removed after success, failure or cancellation. Session history remains in browser memory and is lost on refresh.

This is a local prototyping bridge, not a public deployment backend. Do not expose it with a tunnel or bind it to a public interface. A deployed product needs its own authenticated model-serving architecture and operational limits.

## Troubleshooting

- **Codex CLI could not start:** check `codex --version` and PATH; set `TUTOR_CODEX_BIN` if necessary.
- **Login required:** run `codex login` in your own terminal. Do not paste credentials into the app or chat.
- **Allowance unavailable:** check Codex usage and retry when available. No key-based fallback is used.
- **Another lesson is being planned:** the app waits briefly automatically; if it still cannot obtain a slot, wait for the current request or cancel it in its tab, then retry.
- **Validation failure:** try a more focused concept. The previous picture stays visible; invalid commands are never rendered.
- **Bridge unavailable:** use `npm run dev`, not a static file server or production preview.

The response/visual schemas provide structural and some mathematical checks, not a guarantee of scientific accuracy or teaching quality. Test unseen concepts before using them in the demo.

## References

Official documentation describes [non-interactive execution and structured outputs](https://learn.chatgpt.com/docs/non-interactive-mode), [Codex authentication](https://learn.chatgpt.com/docs/auth), and [configuration controls](https://learn.chatgpt.com/docs/config-file/config-reference). The implementation was exercised with locally installed `codex-cli 0.145.0`; no API credential is extracted from its login.

## Earlier free-form verification

The results below describe the earlier free-form checkpoint. Current compact math results and 144-test validation are in [COMPACT_MATH.md](../COMPACT_MATH.md). The smoke test now defaults to a rectangle-area question.


`npm run test:live-model` performs two real turns through the running HTTP endpoint and consumes Codex allowance; it is deliberately excluded from `npm run check`. An optional topic can be passed as the final argument. `TUTOR_SMOKE_OUTPUT=/private/tmp/tutor-proof.json` saves the generated result locally for inspection.

On the implementation machine, the unseen question **“Why do shadows get longer when the sun is low?”** produced a diagnostic diagram and choice question. The smoke test deliberately chose an incorrect option. The next request included that evidence and the actual canvas, and the model generated an intuition step titled **“Low light makes a long shadow”** with a new five-node diagram and another check. Both responses passed the server and browser planner validators. One successful run took 22 seconds for the first step and 54 seconds for both turns; latency varies and is not yet suitable as a claim of real-time voice performance.

Browser verification also exercised generated multi-beat presentation and its question controls. Automated checks cover bounded repair, exact narration assembly, out-of-bounds drawings, thin shapes, malformed input, local origin checks, cancellation, busy-slot waiting, and all existing planner/canvas behavior. Validation at that checkpoint: 138 tests, TypeScript, main build and independent teaching build. Vite retains bundle-size and future native-config-loader advisories.
