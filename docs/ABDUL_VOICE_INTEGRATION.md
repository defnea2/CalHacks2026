# Abdul + voice integration

Branch: `integration/abdul-voice`.

Merged parents:
- `test/abdul` at `89b918a`: streaming mini-lessons, reteaching, Anthropic text planner, parallelogram cut-and-slide proof.
- `agent/voice-tutor` at `704e7cb`: direct Anthropic provider, faster sentence cuts, preemptive generation and lower playback lead.
- Existing `feature/visual-engine` at `78bc6ca`: animated board adapter and exact sentence-start synchronization.

This is a separate checkout. The original branch and its running previews remain available.

## Local test URLs

This checkout is running on:
- Text tutor / Abdul's lessons: http://127.0.0.1:5176/
- Voice-free canvas test, including **Slant, cut, slide**: http://127.0.0.1:5177/?canvasPreview
- Live voice UI: http://127.0.0.1:5177/?db=abdul-voice (requires the voice backend).

The app defaults remain 5173/5175. To run these separate ports:

```sh
npm run dev -- --port 5176
pnpm --filter client dev --port 5177
```

## Local configuration

Keep keys in the ignored `.env.local` in this checkout:

```dotenv
CARTESIA_API_KEY=
ANTHROPIC_API_KEY=
OPENROUTER_API_KEY=
```

The ignored `.env` prepared on this machine sets Anthropic for tutoring,
OpenRouter for memory extraction, database `abdul-voice`, and Cartesia's direct
batch STT endpoint (`ink-whisper`). This avoids requiring a public STT proxy to
start. The newer `ink-2` proxy option is documented in `VOICE_RUNTIME.md`.
No credentials are committed or printed. Provider model names are configurable;
The configured account was verified against all three providers during local live testing.

After filling the keys, restart the text dev server if it was already running.
Start the voice backend (while retaining the independently running client):

```sh
pnpm dev:voice -- --no-client
```

Or stop the separate client first and use `pnpm dev:voice`; local configuration
sets `VOICE_CLIENT_PORT=5177`. Do not use `--clear` on a database with sessions you
want to keep.

SpacetimeDB 2.13 is installed under ignored `.tools/spacetime/`. The scripts detect
this installation automatically; they also support a normal system CLI or an
explicit `SPACETIME_BIN`. The local database binds to loopback. The worker and
voice client both read this checkout's configuration, including `.env.local`.

## Canvas contract

The canonical compact command schema and generated database schema now include:

```json
{
  "kind": "math_canvas",
  "content": {
    "title": "Does slanting change the area?",
    "moments": [
      {"sentenceOffset":0,"narration":"This shape has a base of six and a height of four.","visual":{"kind":"parallelogram","base":6,"height":4,"shear":2,"stage":"slant"}},
      {"sentenceOffset":1,"narration":"Cut the triangle from the left along the height line.","visual":{"kind":"update","changes":[{"type":"set_parallelogram","stage":"cut"}]}},
      {"sentenceOffset":2,"narration":"Slide that triangle to the right to make a rectangle.","visual":{"kind":"update","changes":[{"type":"set_parallelogram","stage":"reassembled"}]}},
      {"sentenceOffset":3,"narration":"How does moving the same pieces help explain why the area stays the same?","visual":{"kind":"keep"},"showEquation":true}
    ]
  }
}
```

The model generates narration inside each moment. The worker delivers it once,
without another model call. Actual audio cue starts advance the picture.
The same triangle moves; dimensions and
area remain unchanged. The equation is withheld until the final sentence.
Existing interruption, stale-event and duplicate-event guards remain in place.
See `VOICE_CANVAS.md` for the complete adapter contract and current limits,
including client-local canvas manipulation (not yet sent as model evidence).

## Verification

Live testing on 2026-10-24 used synthetic learner speech through Cartesia STT,
Anthropic tutoring, Cartesia reply audio and OpenRouter session summaries.
The final two-turn area lesson produced valid slant → cut → reassembled canvas
commands, with a real synthesized sentence for every visual cue. First reply
audio reached the SDK 3.645 s and 3.950 s after `endTurn`; transcription took
1.826 s and 1.728 s. Earlier runs varied up to 13.349 s to first audio. These are
individual observations, not a latency guarantee; VAD silence and device playback
are excluded.

Run the same provider test with the backend already running:

```sh
pnpm --filter e2e smoke:pipeline
# Optional: one or more custom synthetic learner turns as quoted arguments.
pnpm --filter e2e smoke:pipeline "Show me why two quarters equal one half."
```

This creates clearly named synthetic sessions in the local database, uses real
provider calls, checks audio events and validates the generated pictures through
the production canvas interpreter. Playback acknowledgments are simulated so a
second turn can proceed. It does not capture a microphone, play sound, measure
VAD, or verify audible synchronization. Ended synthetic sessions remain available
for diagnosis. OpenRouter summaries were also observed in the database.

Live testing fixed three integration failures: replies ending immediately after
a board tool, short sentences being merged and shifting visual cues, and invalid
update-only continuations reaching the client. Generation now uses the complete
command schema and the same semantic preflight as playback; a rejected command
gets one bounded repair opportunity. A prediction question should only schedule
its starting picture, not steps intended for a future turn.

## Canvas-first studio and paired generation

The session UI now keeps the canvas, current spoken line and microphone in one
stage. Conversation scrolls independently in a narrow, collapsible sidebar;
lesson administration is under Lesson details. On narrow screens, the canvas is
first and conversation follows. Diagrams use a restrained shared palette,
responsive drawing space and immediate local controls. Transcript updates no
longer scroll the entire page away from the drawing.

New canvas plans pair each visual with its exact narration. Tool-round free text
is treated as planning and never spoken; plain conversational text is released
when the model finishes a round without tools. Tool calls still stream as they
arrive. The final tool-free fallback keeps normal sentence streaming. This avoids
speaking setup/repair chatter, at the cost of waiting for the end of a plain
conversational round before starting its speech.

The tutor defaults to Haiku with medium reasoning effort, thinking disabled.
Generation guidance now requires comparison objects to stay visible together,
preserves quantities during transformations, skips redundant diagnosis, and
distinguishes a shear from rigid cut-and-slide motion. This does not guarantee
mathematically correct natural language: review generated explanations as well
as their validated commands.

Run the real-model check without speech providers or a database:

```sh
pnpm --filter e2e smoke:generation
```

It uses the production agent, tool router and canvas interpreter with an
in-memory transport. The check verifies two simultaneous fraction bars,
amount-preserving repartition on the next turn, and the requested split of a
multiplication array. Observed model-to-complete-plan times at medium effort were
2.557 s, 2.369 s and 1.901 s. These are small-sample observations, not guarantees.

The latest full voice check generated a three-by-seven array, then split it into
five and two with exactly matching spoken cues. First audio arrived 10.626 s
after `endTurn`, including 7.492 s for transcription. Another run had a second-turn
transcription timeout. Model generation and voice transcription must therefore
be measured separately; the new generation path does not eliminate provider
latency. The pipeline smoke checks exact narration-to-cue matching and duplicate
lines. Browser/device playback remains a separate manual check.

Regression coverage includes paired narration, trailing-text suppression,
one-plan-per-reply behavior, invalid-plan repair, preemptive output holding and
interruption. The voice-free preview remains at port 5177 with `?canvasPreview`;
the independent text tutor remains at port 5176. The existing build advisory about
large bundles remains.

Current checks: 241 root, 63 worker, 111 shared, 38 client and 40 database tests
pass (493 total), with their type checks and the voice-client production build.
Browser checks covered the canvas/sidebar toggle, generated fraction and array
layouts, and the voice-free geometry sequence plus an immediate local width edit.
