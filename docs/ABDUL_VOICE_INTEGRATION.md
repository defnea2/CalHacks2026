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
API availability must be verified with the configured account.

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
      {"sentenceOffset":0,"visual":{"kind":"parallelogram","base":6,"height":4,"shear":2,"stage":"slant"}},
      {"sentenceOffset":1,"visual":{"kind":"update","changes":[{"type":"set_parallelogram","stage":"cut"}]}},
      {"sentenceOffset":2,"visual":{"kind":"update","changes":[{"type":"set_parallelogram","stage":"reassembled"}]}},
      {"sentenceOffset":3,"visual":{"kind":"keep"},"showEquation":true}
    ]
  }
}
```

The model speaks one short sentence per moment after the tool call. Actual audio
sentence starts advance the picture. The same triangle moves; dimensions and
area remain unchanged. The equation is withheld until the final sentence.
Existing interruption, stale-event and duplicate-event guards remain in place.
See `VOICE_CANVAS.md` for the complete adapter contract and current limits,
including client-local canvas manipulation (not yet sent as model evidence).

## Verification

Root tests, all voice workspace tests, type checks, frontend builds, database
module build and binding regeneration are required for this integration. Live
provider verification depends on the keys being populated; empty placeholders
are not a live test. The browser preview exercises the same adapter without API
keys, a database, or microphone access.
