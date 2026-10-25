# Animated canvas + voice integration

The active integration branch is `integration/abdul-voice`. It merges `agent/voice-tutor`
(the Cartesia / SpacetimeDB / OpenRouter runtime) and reuses the existing
`TeachingCanvas`, compact math compiler and `VisualDirector`. There is no LiveKit
transport in the merged voice runtime. `docs/LIVEKIT_CARTESIA.md` describes the
older proposed adapter, not this runtime.

## Run and test

From the repo root:

```sh
pnpm install
npm run dev                       # text-only tutor: http://127.0.0.1:5173
pnpm client                       # voice UI: http://127.0.0.1:5175
```

Open **http://127.0.0.1:5175/?canvasPreview** to exercise the production board
adapter without a database, model key, audio device or microphone permission.
Choose multiplication, area, or fractions. Start, advance sentences, interrupt,
replay, and finish speech to unlock local controls. These are explicitly labeled
fixtures, not model-generated demonstrations. Arbitrary text questions still use
the original signed-in Codex bridge on port 5173.

For the actual voice stack, use `pnpm dev:voice` after following
[voice runtime setup](VOICE_RUNTIME.md). It needs the SpacetimeDB CLI and the
teammate's Cartesia/OpenRouter environment. Do not put keys in client code.
The voice client runs on 5175 so it can coexist with the text tutor on 5173.

## Model tool contract

On `integration/abdul-voice`, use the [grounded voice contract](GROUNDED_VOICE.md).
Each generated moment supplies a structured `teaching` intent and a compact
`visual` command. The compiler derives its factual narration from the same
mathematical state. Model prose does not reach production speech.

The entire plan is checked before publication. An invalid plan gets one repair;
unsupported capabilities are acknowledged without a substitute diagram. The
worker stores the compiled narration with its visual and tags the board with
`utteranceId` and the next `sentenceIdx`. Moment N runs when audio for
`sentenceIdx + sentenceOffset` actually starts. This is cue-level alignment,
not word-level alignment. Only the final moment may enable interaction.

Historical recordings and explicit renderer fixtures remain readable. That
compatibility is not a route for generating new ungrounded explanations.

## Synchronization and failure behavior

`PlaybackQueue` checks the AudioContext clock before emitting `onSentenceStart`.
A suspended context does not advance visuals. Flushing cancels pending callbacks
and retires the utterance so late audio cannot restart it.

`useUtteranceState` retains exact played sentence indices. Dropped/skipped audio
never counts as spoken. Ending or interrupting an utterance does not reveal its
remaining pictures. Existing basic board items now follow this rule too.

`SpeechCanvasPlayer` consumes these indices, validates the entire sequence before
applying its first cue, deduplicates subscription updates, preserves local edits
on duplicate updates, and refuses to rewind a newer picture for a late older
item. An update whose earlier moment was skipped is not applied. A new complete
picture can recover. Late board arrival catches up to the latest heard moment;
it cannot retroactively animate a sentence already heard. Clear-board resets the
presentation. Invalid content leaves the current picture intact and displays a
short error; it is never executed as HTML, SVG, JavaScript or arbitrary TeX.

The canvas stays mounted between moments so its existing transitions animate.
Local interactions remain immediate. They currently stay in the client: they are
not persisted in SpacetimeDB or sent to the voice model. Ask the child to explain
what they changed, or use a gap task. Server feedback for continuous canvas edits
would need a separate reducer/event contract; it is not silently treated as an
answer here.

The voice runtime owns lesson decisions; the standalone TeachingPlanner is not
run as a second planner in voice mode. Text mode retains its independent local
reading timer. Voice mode has no reading-time timer.

## Contract maintenance and checks

Canonical content schema: `src/presentation/voice/contracts.ts`.
The checked-in JSON schema used by the database is generated from it:

```sh
node --import ./worker/node_modules/tsx/dist/loader.mjs scripts/export-voice-canvas-schema.ts
npm run check
pnpm test:voice
pnpm typecheck:voice
pnpm --filter client build
```

The schema parity test detects drift. Database schema validation rejects wrong
shapes and numeric limits; the client additionally preflights cross-field and
sequence semantics (valid splits, bars, ranges, ordered offsets). Tests cover
sentence synchronization, duplicate and late events, interruption, dropped audio,
suspended audio clocks, local edits, clear-board and schema parity.

The `integration/abdul-voice` branch has a real-provider, synthetic two-turn smoke
test (`pnpm --filter e2e smoke:pipeline`). It validates generated audio and visual
cue coverage with simulated playback acknowledgments; actual microphone, speaker
and interruption behavior still require device testing. See
[Abdul integration verification](ABDUL_VOICE_INTEGRATION.md#verification) for
observed timings and scope. The local preview remains usable without providers.
