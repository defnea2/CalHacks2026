# Animated canvas + voice integration

The integrated branch is `feature/visual-engine`. It merges `agent/voice-tutor`
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

Use the existing `show_board_item` tool with `kind: "math_canvas"`:

```json
{
  "kind": "math_canvas",
  "content": {
    "title": "One rectangle, two parts",
    "moments": [
      {"sentenceOffset": 0, "narration": "Each of these four rows has eight squares.", "visual": {"kind": "array", "rows": 4, "columns": 8}},
      {"sentenceOffset": 1, "narration": "Split each row into five squares and three squares.", "visual": {"kind": "update", "changes": [{"type": "set_array", "splitAt": 5}]}},
      {"sentenceOffset": 2, "narration": "Did splitting the rectangle change how many squares it covers?", "visual": {"kind": "keep"}, "interactive": true}
    ]
  }
}
```

On `integration/abdul-voice`, generate **narration inside every moment**. Do not
repeat it as ordinary assistant text. The worker validates the complete plan,
publishes the board, and sends each narration directly to the speech queue as
one audio cue. Its punctuation does not change the number of cues. A completed
plan ends the model loop, avoiding a second LLM request and duplicate narration.
Trailing free text and a second narrated canvas in the same reply are suppressed.
The same preemptive-output gate and interruption checks apply to planned speech.

The worker tags the board with `utteranceId` and the next `sentenceIdx`. Moment N
runs when audio for `sentenceIdx + sentenceOffset` actually starts. This is
cue-level alignment, not word-level alignment. Use contiguous offsets starting at
zero, one short spoken idea per moment, and at most one final question.

Old items without narration still work through the legacy follow-up model round.
Mixed narrated/unnarrated moments are rejected. The semantic validator is shared
with the client; invalid commands get one bounded repair round before reaching
the board. The voice-free preview continues to drive the same player with
explicit sentence events; no speech service is needed to test the renderer.

- One to four moments; strictly increasing offsets, starting at zero.
- Start every item with a complete array, bars, geometry or number-line picture.
  Later moments update/keep that picture. This makes recovery after interruption
  independent of an unfinished previous explanation.
- Prefer one canvas item per reply. Multiple new items replace the same canvas;
  they are not appended as separate screenshots.
- Only the final moment may enable interaction. Controls unlock once audio stops
  and the session returns to listening. Observer views remain read-only.
- Use a prediction before revealing equations. Use the existing gap-task tool for
  an assessed answer. A canvas drag is exploration, not evidence of correctness.
- Legacy `visual` SVG items and other board kinds remain supported. The prompt now
  prefers `math_canvas` for dynamic explanations; old library SVG content is not
  automatically translated or animated.

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
