# Tutor: visual lessons and teaching engine

A narration-driven visual engine, with a unified math canvas for the team’s current ages 8–12 tutoring brief. The tutor builds and changes the picture as it explains, then invites the child to explore or respond. This branch integrates the teaching planner with the latest visual engine and a text-first lesson experience.

## Run

Use Node 22.12+ and npm:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. No API keys or backend are required.

## Implemented features

[Full feature inventory and current limits](docs/FEATURES.md) covers every implemented representation, real-time command, interaction, playback feature, and integration boundary.

## Start with a lesson

The default app is a voice-free tutoring session. Choose **Equal groups**, **Small numbers, big ideas**, or **Where does a puddle go?** These are explicitly scripted offline lessons, not live AI generation.

Answer a question to get the next explanation automatically. **Show another way** changes representation, **Smaller step** requests help, and **Continue** advances explanations without a question. Manipulate enabled visuals, then answer or submit the picture when invited. **Your lesson notes** keeps the sequence and recorded evidence; the original homework question stays unsolved for the learner. Refresh clears the session.

For a quick demo: Equal groups → choose **2 + 3** → **Show another way** → move an object into a basket → answer **six** → continue through independent practice. The same layout supports decimals, scientific diagrams, and future topics supplied by a real planning model.

**Use your team's model for another topic** accepts an arbitrary topic and a host-owned planning endpoint. No endpoint is implemented here. Errors are visible and never silently substitute a fixture.

- [Integrated session API, demo checklist, and voice migration](docs/teaching/SESSION.md)
- [Teaching planner and model contracts](docs/teaching/INTEGRATION.md)

## Development tools

Open **Development tools → Live math canvas** for the existing voice-free command preview. Returning to the lesson retains its state. Press **Build the first visual**, then **Next teaching step** to build an array, split it, highlight a part, reveal the derived equation, and add a group. The final step invites learner manipulation. The same cells animate and the equation updates from the model. **Try your own numbers** changes the example without changing lesson code.

After building a model, **Change this example** edits its quantities, focus, scale, equation visibility, and learner permissions live. **Different numbers** and **Simpler example** generate a local variant from the latest learner-edited state. Async agents can read a versioned planning context and reject stale responses.

Choose bars or decimal number lines for other mathematical representations, or a grouping/diagram/shape/sorting activity on the same teaching surface. **Send a visual step as JSON** lets you test plans, cue timing, pause, interruption, and replay. **Inspect scene and learner events** shows the state the agent can receive.

- [Unified canvas and mathematical commands](docs/MATH_CANVAS.md)
- [LiveKit + Cartesia teammate handoff](docs/LIVEKIT_CARTESIA.md)
- [Narration director and free-form drawing API](docs/NARRATION_CANVAS.md)

The public integration entry point is `src/presentation/index.ts`. LiveKit/Cartesia transport and live AI generation are not connected yet. The **Guided explanation** tab retains the recorded water/equal-groups rehearsals for audio synchronization testing. **Interactive building blocks** retains the standalone activity editor.

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

The examples span maths, materials, and a water cycle. They are configurations of reusable components; the engine does not hard-code a subject curriculum. The renderer does not generate arbitrary simulations. The integrated teaching planner checks structured learner responses separately.

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

Automated coverage includes transactional mathematical updates, derived quantities, unified activity rendering, custom-number rehearsals, learner event lifecycle, narration timing, stale playback callbacks, interruptions, replay, child-response gates, demo recordings, invalid configurations, revision safety, preservation of learner work, cancelled gestures, and component interactions. Manual browser checks cover guided audio playback, progressive diagrams, question/hint transitions, interruption and replay, plus object/marker/shape dragging, diagram connections, and equal-scale comparisons. Touch hardware has not been tested.

## Scope and GitHub traceability

Each feature is a separate commit on `feature/visual-engine`. The branch starts from `main`; the earlier `scaffold/shared-contracts` branch is separate and is not required. Voice, teaching/model orchestration, backend, accounts, and the other members' product work remain independent.
