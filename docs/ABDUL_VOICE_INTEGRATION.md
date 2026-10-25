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

The model selects quantities, commands and structured teaching intents. Code
computes factual narration from the actual rendered state. See
[GROUNDED_VOICE.md](GROUNDED_VOICE.md) for the current input format, semantic
checks, failure behavior and coverage limits. The canvas contains only diagrams,
measurements, notation and relevant controls; conversation stays in its panel.

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

## Current architecture

The live voice path now uses the [grounded teaching compiler](GROUNDED_VOICE.md).
The verification timings above describe the earlier integration, not a new
latency benchmark. Mathematical narration is now computed, and unverified
conversational prose cannot bypass that compiler. `ask_learner` handles authored
clarification questions; `visual_unavailable` handles unsupported demonstrations.

The independent text tutor is no longer the focus of this branch's current work.
The manual canvas preview remains a renderer diagnostic, not a second product path.
