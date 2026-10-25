# Anthropic planning and voice integration

Generated lessons now use Anthropic's streaming Messages API by default. The text UI still works without microphones or TTS. Voice mode exposes exact narration and correlated playback events; the future voice host supplies STT, synthesis, audio transport, and actual playout timing.

## Server setup

Copy `.env.example` to `.env.local`, add `ANTHROPIC_API_KEY`, and restart `npm run dev`. Keep the key on the server; never prefix it with `VITE_` or send it from the browser.

```dotenv
TUTOR_PROVIDER=anthropic
TUTOR_ANTHROPIC_MODEL=claude-haiku-5-5
TUTOR_ANTHROPIC_EFFORT=low
```

Choose a model supporting structured JSON outputs and the configured effort level. Access and tutoring quality must be checked against the team's Anthropic account. There is no silent provider/model fallback. `TUTOR_PROVIDER=codex` explicitly selects the older local ChatGPT-login bridge, which still waits for complete responses.

The Vite endpoint remains local-only and is not included in a static build. A deployed host must authenticate sessions and host the planner separately. Anthropic requests have a 45-second deadline (15 s after the first beat), a 4,000-token output cap, a maximum of four concurrent local requests, and one active request per lesson session. Errors surface without automatically replacing speech the learner may already have heard.

## Streaming contract

`POST /api/teaching/plan` with `Accept: text/event-stream` emits version-1 SSE:

| Event | Contents | Meaning |
| --- | --- | --- |
| `blueprint` | `requestId`, `blueprint` | Visual plan with no speakable narration. Closed (complete lesson, preflighted by the client) for single-moment or key-reordered replies; **open** (`open: true`) when streamed, holding only the visuals released so far. |
| `beat` | `requestId`, `index`, `beat` | Complete validated narration paired with fixed visual commands. |
| `complete` | `requestId`, `step`, `metrics` | Full lesson accepted; metrics contain server `firstBeatMs` and `totalMs`. |
| `error` | `error` | Stop generation/playback; connection then ends. |

JSON-only clients still receive a complete validated step. `createStreamingPlanningModel()` handles both formats, request correlation, cancellation, and incomplete streams. It omits redundant browser prompt/schema copies from the request.

Claude emits `{"meta":{...,"check"},"moments":[{visual,narration}...]}`. Each moment is compiled against the canvas planned so far as soon as it parses, and released as a `beat` when the next `,` proves it is not the last. The first `blueprint` is **open**: the client must skip whole-lesson preflight (a one-beat prefix cannot satisfy the minimum-beat policy), append each released beat's visual (`extendBlueprint`), validate each prefix, and run full `validateTeachingStep` only once the stream completes. The server validates the whole assembled lesson with `validateModelStep` before `complete`, and rejects it if any spoken beat differs from the validated one. The final moment carries the check prompt and waits for provider `end_turn`; single-moment lessons therefore wait for completion. Partial JSON or incomplete sentences are never spoken.

Spoken beats are never changed. If a later moment is unusable the server truncates there and closes with a recap beat carrying the check; if the model fails before the first beat, one repair request is made. Otherwise a failure cancels pending audio, leaves the drawing visible and commits nothing. Once the first beat is out, the server aborts a stalled stream after 15 s (`STREAM_DEADLINE_MS`) with an `error` event, and the session slot is released as soon as the client disconnects. Validation does not guarantee correct free-form mathematical prose.

## Host loop (about 20 lines)

```ts
vad.onSpeechStart(() => { session.cancel(); transport.stop(); });           // barge-in: aborts planning, audio and pending cues
stt.onFinal(async text => { if (!await session.submitTranscript(text)) showError(session.getSnapshot().error); });
let lastRun: string | undefined;
session.subscribe(() => {
  const error = session.getSnapshot().error;
  if (error) return showError(error);                                       // planning/validation/stream failure: current picture stays
  const speech = session.getPreparedSpeech();                               // each beat event surfaces as a prepared phrase
  if (!speech || speech.token.runId === lastRun) return;
  lastRun = speech.token.runId;
  let seq = 0;
  const send = (type: "started" | "progress" | "paused" | "ended", elapsedMs = 0) =>
    session.playback({ token: speech.token, sequence: seq++, type, elapsedMs } as never);
  void transport.playExact(speech.narration, { signal: speech.signal, onAudibleStart: () => send("started"),
    onProgress: ms => send("progress", ms) }).then(() => { if (!speech.signal.aborted) send("ended"); })
    .catch(() => { if (!speech.signal.aborted) session.cancel(); });
});
await session.plan();                                                       // resolves after the last beat is accepted
```

`getBufferedNarrations()` may be pre-synthesised for lower gaps. A learner turn after `awaiting_response` is scored; during an explanation it is recorded as unscored context and replans.

## Voice host integration

```ts
import { TeachingSession, createStreamingPlanningModel } from "../../src/teaching";

const session = new TeachingSession(
  { sessionId: crypto.randomUUID(), age: 9, topic: finalInitialTranscript },
  createStreamingPlanningModel(),
  { playback: "voice" },
);
```

Use this session's `planner` and `director` for UI state. Do not run another text coordinator or independently call `director.prepare()` or `planner.presented()`. Voice mode disables reading-time autoplay and `presentNext()` cannot skip speech.

Subscribe **before** `plan()`: a phrase can become ready before its promise resolves. `getPreparedSpeech()` returns `{token, stepId, beatIndex, narration, signal}`. Deduplicate by `token.runId`, speak the exact narration, and retain the token for callbacks. Preparation does not change the picture.

This outline uses `transport` as the teammate's audio adapter, not an installed library:

```ts
let lastRun: string | undefined;
const unsubscribe = session.subscribe(() => {
  const speech = session.getPreparedSpeech();
  if (!speech || speech.token.runId === lastRun) return;
  lastRun = speech.token.runId;
  let sequence = 0;
  const event = (type: "started" | "paused" | "ended") =>
    session.playback({ token: speech.token, sequence: sequence++, type });

  // Must resolve only when audio finishes PLAYING. Abort stops/clears audio.
  void transport.playExact(speech.narration, {
    signal: speech.signal,
    onAudibleStart: () => event("started"),
    onPause: () => event("paused"),
    onResume: () => event("started"),
  }).then(() => {
    if (!speech.signal.aborted) event("ended");
  }).catch(() => {
    if (!speech.signal.aborted) session.cancel();
  });
});
await session.plan();
// Later: await session.submitTranscript(finalTranscript);
// On disconnect/unmount: session.cancel(); unsubscribe();
```

The first visual cue runs at audible `started`. Normal `ended` automatically prepares the next available phrase. Answers and controls unlock only after full generation AND final audible completion. LLM completion, TTS synthesis, and final transcription are not audible completion. `busy` means generation continues; it does not mean speech must wait.

`getBufferedNarrations()` exposes later validated phrases for optional TTS prefetch. Cache synthesis by step ID + beat index + cancellation signal; play only when `getPreparedSpeech()` grants its token. Signal abort invalidates all prefetch and current audio.

For finer cues, send `playback({type: "progress", token, sequence, elapsedMs})` using actual beat-relative delivered audio timing. All lifecycle events share one increasing sequence per token. Old tokens, duplicates, backwards progress, and external scene changes are rejected. Choose one transport owner for lifecycle events.

## Interruptions and STT

- Temporary pause/false interruption: `paused`, then `started` with the same token.
- Confirmed barge-in: send `interrupted` or call `session.cancel()` immediately. This aborts generation and the speech signal while keeping the picture. Never report cancellation as normal `ended`.
- Submit final STT only. A transcript answering a completed check goes through the existing answer validator. Exact spoken numbers are supported. For reliably resolved multiple-choice selections use `respond({kind: "choice", optionId})`; for submitted scene work use `respond({kind: "interaction"})`. Ambiguous speech remains unassessed.
- During an explanation, `submitTranscript()` cancels the current turn, records unscored user context, and replans. Partial STT hypotheses must not become scored answers.
- `replay()` aborts old audio, restores the pre-lesson scene and creates fresh tokens without a model request. Available after generation completes.

LiveKit/Cartesia is still an optional transport. Map its actual playout events to this API and use aligned transcription where available. Do not independently paraphrase accepted narration with a second model.

## Verification

`npm run check` covers streaming, validation, provider errors/cancellation, actual local HTTP-to-session integration, text regressions, and synthetic voice lifecycle events. No paid request is needed.

With the key configured and dev server running, `npm run test:live-model` performs two real requests and consumes provider allowance. Session snapshots expose `firstBeatMs` and `planCompleteMs`, which measure planning rather than audible latency. The future host should also measure end-of-speech, first audible speech, first visual, inter-phrase gaps, interruptions, and p50/p95. Mocked tests do not certify live Anthropic quality, latency or real audio synchronization.

Lesson planning does not use `output_config.format`: the lesson schema compiles to a grammar larger than structured outputs accept ("compiled grammar is too large"). The exact JSON schema is in the system prompt, every reply is validated locally with Zod, and invalid output gets one repair request, only if nothing has been emitted to the learner yet. The slant tutor's small reply schema still uses structured outputs.

References: [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [effort](https://platform.claude.com/docs/en/build-with-claude/effort).

## Latency (measured with `node scripts/latency.mjs`, dev server running, claude-haiku-5-5)

Time to first beat / total, three topics: before 13.1 s / 13.7 s, 9.3 s / 9.9 s, 22.4 s (failed); after 1.7-2.3 s / 2.8-4.1 s. Two changes did it:

- `thinking: {type: "disabled"}`. The model's default adaptive thinking spent ~8-10 s before the first text token; `effort` had no effect on that. Prompt caching works (about 4.2k cached system tokens, `cache_read_input_tokens` > 0), now with `cache_control` on the system block.
- Envelope `{"meta":{...,"check"},"moments":[{visual,narration}...]}`. Meta (with the check) comes first, so a moment is spoken as soon as it compiles; it is released when the next `,` proves it is not the last. The last moment waits for provider completion (it carries the check prompt). The first `blueprint` event is `open: true` and holds only the visuals released so far; each `beat` appends its visual.

Without thinking, about 1 in 9 live lessons fails validation after the first beat was spoken (late bad marker, 3 moments instead of 4, ...); no repair is possible after speech has started. Stray model habits are normalised in code (flags nested in a visual, extra top-level keys, a question inside narration).

Late-failure recovery (streamingLesson.ts): visuals are sanitized (number-line range widened to its markers, duplicate ids renamed, shaded clamped, stray narration questions dropped); a later moment that still fails to compile truncates the lesson there and closes with a "keep" recap beat carrying the check; too few beats are padded before the unspoken final moment. A bad first moment still throws, so the single repair applies.
