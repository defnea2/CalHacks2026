# Unified math canvas

The default **Live math canvas** preview works without a voice agent, API keys, or a backend. Run `npm run dev`, open the printed URL, and press **Build the first visual** followed by **Next teaching step**. The tutor's proposed narration is shown as text. These buttons simulate playback through the same `VisualDirector` used by a future LiveKit adapter.

## Try it

- **Groups → split array → equation:** create 3 × 14; split each row at 10; focus the first part; reveal the derived equation; add a row; invite exploration. Change the sliders and watch the same cells and equation update. **Try your own numbers** generates the sequence with different parameters.
- **Decimals on number lines:** show 0.4 and 0.35 on equal scales; focus a marker; move it to 0.6; invite dragging or keyboard movement. Each marker currently has its own rail with the same scale.
- **Equivalent amounts with bars:** show 1/2 and 1/4; change the second to 2/4; reveal equality; invite shading and repartitioning.
- **Activity examples:** grouping, sorting, connected diagrams, and shape manipulation now render inside `TeachingCanvas`, with the same director and narration lifecycle.
- **Send a visual step as JSON:** edit a `VisualBeat`, prepare it, start playback, advance cues, pause, finish, interrupt, or prepare replay. Preparation does not draw anything. Invalid plans preserve the active picture and beat.
- **Inspect scene and learner events:** see the current model and accepted interaction events. Everything stays in browser memory.

## Public interface

Import from `src/presentation/index.ts`:

```ts
import {
  VisualDirector,
  TeachingCanvas,
  VisualBeatSchema,
  MathVisualSchema,
} from "./presentation";
```

`VisualDirector` owns state. `TeachingCanvas` renders its snapshot. A canvas has one active representation: free-form SVG objects, a mathematical model, or an existing interactive activity. `show_math` and `show_activity` replace the previous representation and clear its note/focus. `clear` returns to free-form drawing. `note` works in every mode. Free-form object commands are rejected while a workspace is active, so they cannot silently update invisible objects.

### Mathematical visual models

Common fields: `id`, `title`; optional `interactive` (false), `showEquation` (false), and `focus` (null). IDs use letters, numbers, `_`, or `-`, up to 80 characters.

| `kind`        | Required fields                               | Constraints                                                                                                                                                       |
| ------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `array`       | `rows`, `columns`                             | 1–12 rows, 1–20 columns. Optional `splitAt` is null or a positive integer below columns. Up to 240 cells; cells are internal to one model, not 240 generic nodes. |
| `bars`        | `bars: [{id, label, parts, shaded}]`          | 1–4 equal-whole bars; 1–12 parts; 0 ≤ shaded ≤ parts. Unique bar IDs.                                                                                             |
| `number_line` | `min`, `max`, `markers: [{id, label, value}]` | 1–6 uniquely identified markers. −1000 ≤ min < max ≤ 1000; values must be in range.                                                                               |

Array focus: `all`, `left`, `right`, or null. Left/right require a split. Bars and number-line focus use a bar/marker ID or null. `showEquation` reveals a computed statement; arrays show the product/decomposition, bars compare the first two amounts exactly, and number lines list marker values. The engine does not accept an independently generated answer string for these statements.

### Commands inside a visual cue

```json
{
  "id": "explain-array",
  "narration": "Here are three groups of fourteen.",
  "cues": [
    {
      "id": "show-array",
      "atMs": 0,
      "commands": [
        {
          "type": "show_math",
          "visual": {
            "id": "array",
            "kind": "array",
            "title": "Multiplication in smaller pieces",
            "rows": 3,
            "columns": 14
          }
        }
      ]
    }
  ]
}
```

Subsequent steps keep the visual ID and use `update_math`:

```json
{
  "type": "update_math",
  "id": "array",
  "change": { "type": "set_array", "splitAt": 10 }
}
```

| Change type       | Fields                                | Effect                                                                                           |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `set_array`       | Optional `rows`, `columns`, `splitAt` | Patches the existing array and keeps cell identities.                                            |
| `set_bar`         | `barId`, optional `parts`, `shaded`   | Changes the named bar. Supply both values together when preserving a proportion, e.g. 1/2 → 2/4. |
| `move_marker`     | `markerId`, `value`                   | Moves a named marker within its scale.                                                           |
| `set_range`       | `min`, `max`                          | Changes the number-line scale; all current markers must still fit.                               |
| `set_focus`       | `target`                              | Highlights an array part or a named bar/marker; null clears focus.                               |
| `set_interaction` | `enabled`                             | Grants or removes learner manipulation.                                                          |
| `set_equation`    | `visible`                             | Reveals or hides the derived statement.                                                          |

Updates validate the **resulting model**. They do not silently clamp or repair inconsistent input. If shrinking an array invalidates a split, include a new `splitAt` in the same update. If removing a split while focusing a part, clear focus first. Every cue is transactional; preparation preflights the entire beat. An invalid later cue does not replace the currently active beat.

### Existing activities

`{type: "show_activity", sceneId, activity}` accepts the existing `ActivitySpec` schema. A fresh scene starts with no placements or selections. `{type: "activity_command", command}` accepts a revision-checked `SceneCommand`, including `update_activity`, `highlight`, placement, shape transforms, and diagram connections. Prefer `update_activity` when retaining learner work. Activity types and examples are in `src/shared/contracts.ts` and `src/shared/fixtures.ts`.

## Playback and learner actions

```tsx
const snapshot = useSyncExternalStore(director.subscribe, director.getSnapshot);

<TeachingCanvas
  canvas={snapshot.canvas}
  interactionEnabled={director.canInteract()}
  choiceIds={
    snapshot.status === "awaiting_answer"
      ? snapshot.beat?.question?.nodeIds
      : []
  }
  onChoose={(id) => {
    const result = director.respond(id);
    if (result) sendToTutor(result);
  }}
  onMathAction={(action) => {
    if (!snapshot.token) return;
    const result = director.interactMath(snapshot.token, action);
    if (result) sendToTutor(result);
  }}
  onActivityAction={(action) => {
    if (!snapshot.token) return;
    const result = director.interactActivity(snapshot.token, action);
    if (result) sendToTutor(result);
  }}
/>;
```

`prepare(beat)` returns a fresh `{runId, beatId}` token. Pass that exact token to `narrationStarted`, `narrationProgress(token, elapsedMs)`, `narrationPaused`, `narrationEnded`, and `interrupt`. Capture it per playback operation; never substitute “whatever token is current” for a delayed callback.

Learner edits require both model permission and a completed/awaiting-answer director state. During preparation, narration, pause, or interruption they are rejected. Math events carry `{eventId, visualId, revision, change}`. The director rejects stale revisions, duplicate events, incorrect visual IDs, incompatible changes, and actions from old playback runs. Learners can change arrays, bar quantities, and marker positions; only tutor commands can reveal equations, focus, change scale, or enable controls.

Accepted math events have `{type: "math_changed", token, action, scene}`; activity events have `{type: "activity_changed", token, action, scene}`. The returned scene is the updated state. A null result means rejected/no new event: do not forward it as an accepted answer. Treat snapshots as read-only. Repeated exploration events do not themselves trigger narration; the teaching agent decides when to respond.

The existing `question.nodeIds` option is for choosing free-form objects. Math exploration uses the change-event channel and can continue after a beat finishes. `replay()` restores the canvas as it was before the current beat and returns a fresh token; subsequent learner work within that beat is intentionally undone.

## Current boundaries

This is a deterministic renderer and interaction runtime, not an LLM or curriculum. The rehearsal scripts demonstrate the commands; they do not generate responses to arbitrary speech. The canvas hosts one main representation at a time. A simultaneous multi-panel scene, symbolic algebra, arbitrary simulations, and arbitrary generated UI are not implemented. Equation text is derived plain text, not a TeX typesetter. Array motion animates stable SVG cells; number-line movement is animated; bar shading/partition changes update the reused components.

The next integration is described in [LIVEKIT_CARTESIA.md](LIVEKIT_CARTESIA.md). Real LiveKit audio and Cartesia timing have not been tested in this branch.

## Live configuration and asynchronous planning

The **Change this example** inspector appears after a model is built. It sends the same `show_math`/`update_math` commands as the agent will. It can modify quantities, scale, focus, equations, and permissions directly. Controls are locked during simulated playback. The remaining fixed rehearsal is disabled after a custom edit, and the note is replaced to avoid narrating the old quantities. Restart the example to return to its script.

**Different numbers** and **Simpler example** call the exported `createMathExample(currentVisual, intent)` helper using the _latest_ model, including learner edits. This is a deterministic integration fixture, not an AI teaching policy or proof that an example is pedagogically appropriate. Creating a variant starts a new visual scene with revision zero; the director's monotonic context version and fresh playback token distinguish it from earlier scenes even when the visual ID is retained.

For an asynchronous model call:

```ts
const context = director.getPlanningContext();
const beat = await planExplanation(context); // Your agent/model implementation.
const token = director.prepare(beat, {
  expectedContextVersion: context.contextVersion,
});
// Bind this token to the corresponding real speech operation before playback.
```

`getPlanningContext()` returns a detached copy of `{contextVersion, token, status, canvas}`. `contextVersion` advances when the canvas, playback token, or lifecycle status changes, including replay/reset. Audio clock ticks with no scene change do not advance it. A stale guarded prepare throws without replacing the active scene. Re-read context and replan; do not simply change the expected version on an old plan.

`prepare` keeps the guard optional for compatibility with existing local rehearsals. The LiveKit adapter should require `expectedContextVersion` for asynchronously generated plans. Accepted math/activity events include the resulting `contextVersion` alongside the scene. The version guard prevents stale results from being applied; request cancellation, retry/coalescing, and network delivery remain adapter responsibilities.
