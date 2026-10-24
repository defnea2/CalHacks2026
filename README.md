# Interactive visual engine

A narration-driven visual engine for a general tutor for ages 7–9. The tutor builds and changes the picture as it explains, then invites the child to explore or respond. This branch contains the visual modules, tests, and development rehearsals.

## Run

Use Node 22.12+ and npm:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. No API keys or backend are required.

## Start with the guided explanation

The default preview now follows the tutor through an explanation. Press **Start explanation** to hear a scripted recording while the canvas reveals objects, animates changes, draws connections, and directs attention. It pauses for a child response, then continues with a hint or feedback.

Two examples—water’s journey and equal groups—use the same engine. Pause, interrupt, replay, or inspect the cues without connecting a live agent. The recorded audio is a development fixture; the visuals are rendered live from commands.

[Voice integration and narration-canvas API](docs/NARRATION_CANVAS.md) explains how a teammate can replace the recordings with real playback events and generated visual beats. The public entry point is `src/presentation/index.ts`.

## Interactive building blocks

| Visual                 | Interactions                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------ |
| Objects and groups     | Drag into containers, select and place, return to tray, live counts                  |
| Sorting boards         | The same placement engine with configurable categories and item order                |
| Equal-part bars        | Change partitions, colour or clear amounts, compare on equal scales                  |
| Number lines           | Drag markers, use arrow keys and Home/End, enforce numeric bounds                    |
| Diagrams and sequences | Drag or use buttons to reorder stages, connect nodes with arrows, remove connections |
| Shapes                 | Drag, rotate, reflect, move by keyboard, show mirror guides                          |

Every mode supports tutor highlights. Pointer interactions support mouse, pen, and touch; click/keyboard alternatives are included. Escape or a scene revision change cancels a drag. Reduced-motion preferences are respected.

The examples span maths, materials, and a water cycle. They are configurations of reusable components; the engine does not hard-code a subject curriculum. It does not generate arbitrary simulations or evaluate a child's answer.

## Explore a new topic

1. Choose an example and interact with it.
2. Open **Configure an activity** and edit the JSON. Labels, prompts, objects, categories, connections, and values are configurable.
3. Use **Update current activity** to keep the same activity identity and preserve surviving placements, selection, highlights, and order. Numeric and shape properties are replaced by the supplied configuration, so copy the current activity into the editor first if those should be retained.
4. Use **Load as new activity** for a fresh scene. Invalid JSON leaves the current scene intact.
5. Use **Highlight selection** to try a tutor cue. Inspect **Scene & interaction log** to see commands and resulting state.

## Integrate the module

The public entry point is `src/visuals/index.ts`. The workspace imports its own scoped CSS. Runtime dependencies are React, React DOM, Motion, and Zod.

```tsx
import { useState } from "react";
import {
  LearningWorkspace,
  createScene,
  applySceneCommand,
  commandFromAction,
  type ActivitySpec,
} from "./visuals";

export function Activity({ activity }: { activity: ActivitySpec }) {
  const [scene, setScene] = useState(() =>
    createScene(activity, `scene-${crypto.randomUUID()}`),
  );

  return (
    <LearningWorkspace
      scene={scene}
      onAction={(action) => {
        setScene((current) => {
          const result = applySceneCommand(current, commandFromAction(action));
          return result.scene;
        });
      }}
    />
  );
}
```

The host owns scene state and handles rejected commands. The component emits validated, revision-tagged `LearnerAction` objects without mutating its input. The reference reducer is optional; other teammates can use their own state owner.

`src/shared/contracts.ts` defines this module's types and Zod schemas. These are module integration types, not a requirement to adopt a team-wide architecture. `src/shared/fixtures.ts` contains complete examples of every activity configuration.

An external tutor can submit a `SceneCommand` through the same reducer:

```ts
const result = applySceneCommand(scene, {
  contractVersion: scene.contractVersion,
  commandId: crypto.randomUUID(),
  sceneId: scene.sceneId,
  expectedRevision: scene.revision,
  payload: { type: "highlight", objectIds: ["seed-1"] },
});
```

Commands also support the learner actions, `update_activity`, `replace_activity`, and `clear_highlights`. Successful commands increment the revision. Duplicates are acknowledged without replay; stale revisions and wrong-scene commands are rejected. Re-read the latest scene before replanning a rejected command. Use a fresh scene ID when resetting an activity so delayed events cannot land in the new scene.

`update_activity` preserves surviving object relationships by stable ID. `replace_activity` starts the new activity without previous placements or selections. JSON is data only: no model-generated JavaScript or HTML is executed.

## Verification

```sh
npm run check        # TypeScript, all tests, production build
npm run test:visuals # Canvas, narration, components, pointer interactions and geometry
npm run test:state   # Schemas and scene transitions
```

Automated coverage includes narration timing, stale playback callbacks, interruptions, replay, child-response gates, demo recordings, invalid configurations, revision safety, preservation of learner work, cancelled gestures, and component interactions. Manual browser checks cover guided audio playback, progressive diagrams, question/hint transitions, interruption and replay, plus object/marker/shape dragging, diagram connections, and equal-scale comparisons. Touch hardware has not been tested.

## Scope and GitHub traceability

Each feature is a separate commit on `feature/visual-engine`. The branch starts from `main`; the earlier `scaffold/shared-contracts` branch is separate and is not required. Voice, teaching/model orchestration, backend, accounts, and the other members' product work remain independent.
