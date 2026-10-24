# LiveKit + Cartesia handoff

The visual engine is ready for a transport adapter. This document specifies that boundary. **This branch does not install LiveKit, start an agent server, call Cartesia, or implement the RPC adapter.** It supplies the tested director, schemas, renderer, math models, and voice-free rehearsal.

Start with [MATH_CANVAS.md](MATH_CANVAS.md). Public exports are in `src/presentation/index.ts`. Cartesia/LiveKit secrets and room-token creation belong on the teammate's server.

## Compact math commands

[COMPACT_MATH.md](COMPACT_MATH.md) documents the new model-facing quantity commands and `compileMathCommand`. Compile against the current canvas, then prepare the resulting commands with its context version. These commands use the same VisualBeat and playback lifecycle below; they do not introduce another transport. New geometry events use `set_geometry`, and interaction checks can read `geometry_area`, `geometry_width` or `geometry_height`.

## Teaching planner is integrated

The default app now generates real plans through the [local no-key Codex bridge](teaching/LOCAL_MODEL.md) and runs `TeachingSession` in **text mode**: one validated beat is displayed immediately; later beats wait for Continue. This is not the LiveKit adapter and must not be used unchanged for speech. [SESSION.md](teaching/SESSION.md) describes the planner/director coordination, version checks, and the migration boundary. [INTEGRATION.md](teaching/INTEGRATION.md) defines teaching steps and learner responses.

The voice host should speak the accepted planner beat's narration, then acknowledge `planner.presented(step.id)` only after the **last** beat actually finishes. Retain one authoritative planner and director; do not run the text coordinator alongside another independently advancing voice session.

## Ownership

- Visual module: validates commands, maintains the canvas, derives mathematical quantities, renders/animates, gates learner edits, and returns accepted learner events.
- Agent: diagnoses the misunderstanding, chooses representations, generates a `VisualBeat`, speaks its `narration` through Cartesia, and reacts to learner events.
- LiveKit adapter: authenticates the peer, sends/acknowledges plans, correlates speech with visual tokens, forwards playback/interrupt signals, and sends learner events back.

Generate narration and visual commands as one teaching step. Avoid an unrelated visual model trying to reconstruct meaning after the speech was already generated.

## First integration: one phrase, one visual change

Use short `VisualBeat` objects with a single cue at `atMs: 0`. This avoids guessing how long Cartesia will take to say a phrase.

1. Agent sends the beat to the linked frontend participant.
2. Frontend calls `director.prepare(beat, {expectedContextVersion})`, then acknowledges the returned `{runId, beatId}`. Invalid input returns a validation error; retain the existing explanation and ask the agent to repair its plan.
3. Associate the acknowledgement token with the specific LiveKit speech operation/turn and its transcription segment(s).
4. Speak **exactly that beat's narration**. When synchronized playout begins, call `director.narrationStarted(token)`.
5. On actual normal playout completion call `director.narrationEnded(token)`. Do not treat “LLM finished,” “TTS synthesized,” or “final transcript received” as the end of audible speech.
6. When invited, a learner action updates the canvas immediately through the director. Forward the accepted result to the agent; it includes the new mathematical model or activity state.

The current HTML-audio adapter is a reference implementation for recordings only. Do not use an HTML audio element's `currentTime` as a per-beat clock for LiveKit's continuous WebRTC track.

## Proposed transport contract

These are application method names for the teammate to implement, not built-in LiveKit methods. Use LiveKit RPC for small request/response controls; it supports agent tools forwarding structured UI actions to the frontend. [Official frontend tool forwarding](https://docs.livekit.io/agents/logic/tools/forwarding/)

### `visual.prepare` — agent → frontend

Request:

```json
{
  "version": 1,
  "requestId": "request-unique-within-session",
  "expectedContextVersion": 12,
  "beat": {
    "id": "split-array",
    "narration": "Let us split each group into ten and four.",
    "cues": [
      {
        "id": "split",
        "atMs": 0,
        "commands": [
          {
            "type": "update_math",
            "id": "array",
            "change": { "type": "set_array", "splitAt": 10 }
          }
        ]
      }
    ]
  }
}
```

Success: `{version: 1, requestId, ok: true, token: {runId, beatId}}`.
Failure: `{version: 1, requestId, ok: false, error: "invalid_plan", message}`.

The example assumes a previous `show_math` created `array` and the agent read context version 12; use the actual version returned by `getPlanningContext()`, never a hard-coded constant. The adapter must require `expectedContextVersion` and return a stale-context error if the current version differs. Re-read state and regenerate the plan rather than retrying the old plan with a new version.

The example assumes a previous `show_math` created `array`. The first step must create its representation. `VisualBeatSchema.parse`/`director.prepare` are the validation source of truth.

The adapter should cache each request ID and its payload/result for the session. A transport retry with the same ID and identical payload returns the same acknowledgement, not a fresh token. Reject reuse with a different payload. Cache invalid results too; a repaired plan needs a new request ID. Bound/clear this cache when the room session ends. This request cache is adapter work; `VisualDirector.prepare` intentionally creates a fresh run on every call.

### `visual.playback` — correlated lifecycle signals → frontend

Application envelope:

```ts
type PlaybackMessage = {
  version: 1;
  token: { runId: string; beatId: string };
  sequence: number;
} & (
  | { event: "started" | "paused" | "ended" | "interrupted" }
  | { event: "progress"; elapsedMs: number }
);
```

Map events to the corresponding director methods. `started` also resumes a pause. Keep one monotonically increasing sequence per run and ignore duplicate/older messages **in the adapter**. The director already rejects stale tokens, duplicate cues, and backwards progress, but does not sequence arbitrary transport messages. Designate one owner for lifecycle ordering; do not race independent backend and frontend clocks.

On success acknowledge the request with the token and current director status. If the token no longer matches the snapshot, return an explicit stale result. `narrationEnded` flushes remaining cues by design; send it only for normal completion. Never use it to report cancellation.

### `visual.get_state` — agent → frontend

Return `director.getPlanningContext()`: a detached `{contextVersion, token, status, canvas}` snapshot. Include `appliedCueIds` separately if useful. Read this after a rejected stale operation. Do not blindly resend a plan based on obsolete learner work. Serialize only the relevant representation for model context; internal event-ID histories are not teaching content.

### `visual.learner` — frontend → agent

Send the accepted return value of `interactMath` or `interactActivity` (including its resulting `contextVersion`), or the existing `respond` result for object choices. Add the transport version/session correlation in the adapter. The agent should deduplicate by session + runId + eventId (for choices, runId + nodeId). Use a structured custom data handler/RPC on the agent; a change event should not be indiscriminately inserted as user chat text and interrupt current speech.

For sliders, the browser applies each accepted change immediately. Coalesce outbound changes by visual/object during a gesture, retaining the latest state, or wait for gesture completion in the adapter. The current component emits individual accepted changes; network coalescing is not implemented here.

On disconnect/reconnect, cancel the current run, obtain a fresh state/plan, and map a new speech operation to a new token. Never resume stale playback signals into a reset canvas. Restrict control RPCs to the intended agent participant and clean up handlers when leaving the room.

## Cartesia-specific timing

Cartesia's LiveKit plugin supports aligned transcription. Enable alignment on the agent session and retain synchronized transcription forwarding. [Cartesia integration](https://docs.livekit.io/agents/models/tts/cartesia/)

Python configuration fragment:

```python
session = AgentSession(
    # Existing stt, llm, tts=cartesia.TTS(...), vad, ...
    use_tts_aligned_transcript=True,
)
# On session.start(...):
room_options = room_io.RoomOptions(
    text_output=room_io.TextOutputOptions(
        sync_transcription=True,
        json_format=True,
    )
)
```

Node configuration fragment:

```ts
const session = new voice.AgentSession({
  // Existing vad, stt, llm, Cartesia tts, ...
  voiceOptions: { useTtsAlignedTranscript: true },
});
// On session.start(...):
const outputOptions = { syncTranscription: true, jsonFormat: true };
```

These are fragments to add to the teammate's configured session, not standalone agent programs. Pin/check the installed LiveKit SDK version; transcription timing hooks are experimental. The frontend receives `lk.transcription` text streams, with JSON timing fields when available. Do not assume every Cartesia access path or provider fallback emits word timings. [LiveKit text and timing documentation](https://docs.livekit.io/agents/multimodality/text/)

For finer synchronization later:

- Correlate each speech operation and transcription segment to the acknowledged visual token; a room-wide `speaking` flag alone is insufficient.
- Normalize turn-relative timing to beat-relative milliseconds. Preserve the turn/beat offset when one turn includes multiple phrases.
- Trigger visual progress from **synchronized delivered** transcription/playout, not raw chunks produced ahead of playback. A transcription callback that sees a word's end timestamp does not prove that word has already finished playing.
- Do not infer cue offsets from character count, model token arrival, or wall-clock time since the TTS request. The current director accepts numeric `atMs`, not word-anchor commands. Use one-cue phrases until the adapter can supply aligned timing; building word-anchor resolution is future work.
- Verify the timing on the exact SDK/provider route with actual audio before claiming word-accurate synchronization.

## Interruptions

Pause visual progression when audio pauses. If a false interruption resumes the same speech, resume the same token. On a confirmed cancellation, stop/clear audio in the voice layer and call `director.interrupt(token)`; pending visual cues are discarded while the current drawing stays visible. A new explanation calls `prepare` again. LiveKit can resume false interruptions, so distinguish these cases in the adapter. [LiveKit interruption behavior](https://docs.livekit.io/agents/logic/turns/)

Replay is deliberate: call `director.replay()`, bind its new token to a newly spoken copy of that beat, and start it. It restores the picture from before the beat. It must not reuse the interrupted audio callback/token.

## Integration acceptance checks

- Preparing a plan does not change the current picture; first spoken phrase starts the first cue.
- A malformed command is rejected before replacing the active explanation.
- Agent and learner changes both produce the same derived equation/quantities.
- A bar/number-line interaction reaches the agent with the updated scene.
- Barge-in stops pending visuals; delayed speech events cannot mutate the next explanation.
- False-interruption resume does not replay already-applied cues.
- Normal completion unlocks only explicitly enabled learner controls.
- Duplicate transport requests/actions do not produce repeated visual changes.

The local test suite verifies the visual-side lifecycle and actions. Room connectivity, Cartesia audio, transport ordering, latency, and real spoken interruption remain integration tests for the teammate's adapter.
