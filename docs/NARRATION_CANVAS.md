# Narration-driven canvas integration

The product interaction is: **the tutor explains an idea while building its visual representation**. Child interaction is an invitation within that explanation, not a prerequisite for every visual change.

`src/presentation` is the module for this interaction. The teaching canvas also hosts mathematical models and the hands-on components from `src/visuals`. See [MATH_CANVAS.md](MATH_CANVAS.md) for the unified commands and [LIVEKIT_CARTESIA.md](LIVEKIT_CARTESIA.md) for the transport handoff. Neither module needs the other teammates' backend or app architecture.

## Try the experience now

Run `npm run dev`, keep **Guided explanation** selected, and press **Start explanation**. Two local rehearsals demonstrate the same engine:

- Water: introduce a puddle, reveal the sun, move a representation of vapour upward, connect cloud and rain, then ask the child a question.
- Equal groups: introduce twelve seeds, animate them into three groups, show the equation, then ask about another equal group.

The recordings are scripted fixture narration, not live AI. The diagram is rendered and updated by commands in real time; it is not a video. There are no keys or external services. A mistaken choice gives a scripted spoken hint and another opportunity to answer.

**Wait, pause here** cancels pending cues. **Show that again** restores and replays the start of the current part. Under **Rehearsal controls & voice integration**, manual cues let you inspect the same commands without sound. Changing playback mode restarts the current part.

## Boundary for the voice/teaching teammate

Import from `src/presentation/index.ts`. The voice/teaching host supplies one validated `VisualBeat` at a time. A beat contains narration, ordered visual cues, and an optional invitation to choose an object.

```ts
const token = director.prepare({
  id: "explain-warmth",
  narration: "The sun warms the water.",
  cues: [
    {
      id: "show-sun",
      atMs: 0,
      commands: [
        {
          type: "add",
          nodes: [
            {
              id: "sun",
              kind: "object",
              icon: "sun",
              label: "Sun",
              x: 200,
              y: 150,
              width: 160,
              height: 150,
              tone: "sun",
            },
          ],
        },
        { type: "highlight", ids: ["sun"] },
      ],
    },
  ],
});
```

`prepare()` preflights all cues and references without altering the current drawing. Invalid plans throw and leave the active plan intact. A new beat preserves the existing canvas unless it explicitly uses `clear`. Keep object IDs stable across beats.

Connect real playback callbacks, keeping the returned token in each callback closure:

```ts
// From the actual audio player, not from text generation or the synthesis request:
director.narrationStarted(token); // audio is playing
director.narrationProgress(token, elapsedMs); // actual time within this beat
director.narrationPaused(token); // playback paused
director.narrationEnded(token); // playback finished

// On barge-in, stop audio in the voice layer as well:
director.interrupt(token);
```

`NarrationAudio.tsx` is a working reference adapter for HTML audio. It uses `playing`, `timeupdate`, `pause`, and `ended`, not an independent wall clock. For LiveKit streaming speech, a dedicated adapter must correlate speech operations and synchronized playout with tokens; the continuous WebRTC audio track is not a per-beat HTML audio clock. See the LiveKit/Cartesia handoff above.

Prefer short semantic beats with a cue at `atMs: 0` until audio alignment is available. For changes inside a sentence, supply cue times aligned to the generated audio. Do not guess alignment from text token arrival. If narration ends before a later cue, the director applies remaining cues at the end so the scene reaches its intended final state.

A token contains a fresh `runId` plus the beat ID. Events from interrupted or replaced playback are ignored, even if the same beat ID is reused. Cue application is idempotent, backwards clock ticks are ignored, and updates stop while paused. `replay()` returns a fresh token and restores the canvas from before this beat.

## Render and return learner input

```tsx
const state = useSyncExternalStore(director.subscribe, director.getSnapshot);

<TeachingCanvas
  canvas={state.canvas}
  choiceIds={
    state.status === "awaiting_answer" ? state.beat?.question?.nodeIds : []
  }
  onChoose={(nodeId) => {
    const response = director.respond(nodeId);
    if (response) sendResponseToTutor(response);
  }}
/>;
```

The renderer makes objects interactive only when invited. Responses are accepted only for current allowed objects, once, after narration ends. The host decides what the response means and prepares the next beat. Assessment and language understanding belong to the teaching/voice side; the demo's fixed correct-answer branch is only a rehearsal fixture.

## Drawing vocabulary

The canvas uses a 1000 × 600 coordinate space, scaled to the display. Positions refer to object centres. Commands are structured data, not generated code.

| Command                              | Meaning                                                        |
| ------------------------------------ | -------------------------------------------------------------- |
| `show_math` / `update_math`          | Create or modify a parameterized mathematical representation   |
| `show_activity` / `activity_command` | Host and direct an existing interactive activity               |
| `clear`                              | Start a new scene and title                                    |
| `add`                                | Reveal labelled icons, text, circles, rectangles, or triangles |
| `update`                             | Animate position, size, rotation, tone, or change a label      |
| `remove`                             | Remove objects and their dangling connections/focus            |
| `connect`                            | Draw a labelled arrow between existing objects                 |
| `highlight`                          | Emphasise a set of objects                                     |
| `point`                              | Attach an attention label to an object                         |
| `note`                               | Set the short explanation below the drawing                    |

Each cue is applied atomically. The engine bounds scene sizes, validates IDs and references, and respects reduced-motion settings. It supports the listed primitives; arbitrary scientific simulations, generated illustrations, and free-form code are not included.

## Ownership

Our visual work: canvas rendering, transitions, attention cues, playback synchronization, interruption/replay, and the response event boundary.

Voice teammate: audio generation/playback, microphone, turn detection and interruption signals.

Teaching teammate: choosing what to explain, generating valid visual beats, adapting to the child's response, and deciding the next beat.

Product teammate: the session shell and deployment. The workbench is a development preview, not a replacement for that work.

## Fixture audio

Committed WAV files run on any supported browser platform. They are locally synthesised readings of the demo scripts. To regenerate on macOS with the installed Samantha voice:

```sh
node --experimental-strip-types scripts/render-demo-narration.mjs
```

Tests verify recordings exist, cues fit within their duration, the demo plans execute, and the media adapter follows the real playback clock.
