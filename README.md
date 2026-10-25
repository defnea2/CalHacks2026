# Tutor: visual lessons and teaching engine

A narration-driven visual engine, with a unified math canvas for the team’s current ages 8–12 tutoring brief. The tutor builds and changes the picture as it explains, then invites the child to explore or respond. This branch integrates the teaching planner with the latest visual engine and a text-first lesson experience.

## Run

One static client app (`client/`, Vite, port 5175) talks only to SpacetimeDB; the LLM runs in `worker/`. The team UI in `src/` (app shell, lessons, canvas, visuals) is part of that build under the alias `@tutor/visual` (see [client/README.md](client/README.md) "One app").

```sh
pnpm install
pnpm stdb:start && pnpm stdb:publish   # local SpacetimeDB + module
pnpm worker                            # LLM worker (keys from .env)
pnpm dev                               # = pnpm --filter client dev → http://127.0.0.1:5175
```

`/` is the entry page: students pick or create themselves and either learn by themselves (task + optional photo, talk or type) or wait for their teacher (they join the class session automatically); teachers set goals, teaching instructions, optional material and simulated students, start a class session and follow it on the dashboard (summary, clusters of 2 or 4 students, observe any student live) — see [docs/CLASSROOM.md](docs/CLASSROOM.md) and [client/README.md](client/README.md); `?lesson` opens the team lesson lab (prepared and sample lessons work offline; a typed question starts a text-mode session in the same session screen); `?observe=<id>` and `?overview` are read-only. `pnpm build` writes static files to `client/dist/` (no `/api/*` endpoints exist anymore).

## Compact math and instant exploration

Choose **Open math studio** for local area, triangle, group, fraction and number-line explorations. KaTeX typesets linked equations; Mafs handles interactive geometry. The model now emits compact quantities and actions instead of pixel layouts. [Commands, architecture, verified behavior and limits](docs/COMPACT_MATH.md).

## Implemented features

[Full feature inventory and current limits](docs/FEATURES.md) covers every implemented representation, real-time command, interaction, playback feature, and integration boundary.

## Start with a lesson

The default app is a voice-free tutoring session. Enter a conceptual math question and select **Start** to generate a new explanation and diagram with the real model. Supported explanations can contain several connected visual moments, played locally with Pause, Next and Replay; the final question waits until the explanation finishes. **Equal groups**, **Comparing decimals**, and **Where does a puddle go?** remain explicitly scripted offline samples.

Answer a question to get the next explanation automatically. **Show another way** changes representation, **Smaller step** requests help, and **Continue** advances explanations without a question. Manipulate enabled visuals, then answer or submit the picture when invited. **Your lesson notes** keeps the sequence and recorded evidence; the original homework question stays unsolved for the learner. Refresh clears the session.

For a quick demo: Equal groups → choose **2 + 3** → **Show another way** → move an object into a basket → answer **six** → continue through independent practice. The same layout supports decimals, scientific diagrams, and future topics supplied by a real planning model.

**Homework and settings** lets you preserve a homework question; the connection line reads the worker heartbeat (`agent_status`). Live lessons are planned by the worker and validated by the SpacetimeDB module (`beat` rows); errors are visible and never silently substitute a fixture.

- [Integrated session API, demo checklist, and voice migration](docs/teaching/SESSION.md)
- [Teaching planner and model contracts](docs/teaching/INTEGRATION.md)

## Development tools

Open **Development tools → Live math canvas** for the existing voice-free command preview. Returning to the lesson retains its state. Press **Build the first visual**, then **Next teaching step** to build an array, split it, highlight a part, reveal the derived equation, and add a group. The final step invites learner manipulation. The same cells animate and the equation updates from the model. **Try your own numbers** changes the example without changing lesson code.

After building a model, **Change this example** edits its quantities, focus, scale, equation visibility, and learner permissions live. **Different numbers** and **Simpler example** generate a local variant from the latest learner-edited state. Async agents can read a versioned planning context and reject stale responses.

Choose bars or decimal number lines for other mathematical representations, or a grouping/diagram/shape/sorting activity on the same teaching surface. **Send a visual step as JSON** lets you test plans, cue timing, pause, interruption, and replay. **Inspect scene and learner events** shows the state the agent can receive.

- [Unified canvas and mathematical commands](docs/MATH_CANVAS.md)
- [LiveKit + Cartesia teammate handoff](docs/LIVEKIT_CARTESIA.md)
- [Narration director and free-form drawing API](docs/NARRATION_CANVAS.md)

The visual integration entry point is `src/presentation/index.ts`; the voice-ready coordinator is exported from `src/teaching/index.ts`. Anthropic supplies streaming plans. `TeachingSession` voice mode accepts final STT text and exposes exact phrases, cancellation signals and playback events. LiveKit/Cartesia transport is not connected yet. The **Guided explanation** tab retains recorded rehearsals for audio synchronization testing. **Interactive building blocks** retains the standalone activity editor.

## Interactive building blocks

| Visual                 | Interactions                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------ |
| Objects and groups     | Drag into containers, select and place, return to tray, live counts                  |
| Sorting boards         | The same placement engine with configurable categories and item order                |
| Equal-part bars        | Change partitions, colour or clear amounts, compare on equal scales                  |
| Number lines           | Drag markers, use arrow keys and Home/End, enforce numeric bounds                    |
| Diagrams and sequences | Drag or use buttons to reorder stages, connect nodes with arrows, remove connections |
| Shapes                 | Drag, rotate, reflect, move by keyboard, show mirror guides                          |

## Memory extraction

Every `MEMORY_EVERY_N_TURNS` turns (default 6) the `extractMemory` procedure sends the new conversation window plus the learner's existing notes to an LLM and stores notes, evidence quotes and mastery estimates (items below confidence 0.7 are dropped; duplicate creates become `reinforce`). `endSession` schedules a final window and `summarizeSession`. Both are background calls, so they don't add to turn latency.

- **Provider:** Claude Haiku 5.5 (`claude-haiku-5-5`) through the Anthropic Messages API when `ANTHROPIC_API_KEY` is set; otherwise the OpenRouter path (`OPENROUTER_EXTRACTION_MODEL`). Force one with `MEMORY_PROVIDER=anthropic|openrouter`; override the model with `ANTHROPIC_EXTRACTION_MODEL`. `scripts/publish.mjs` passes all three plus the key into the module env.
- **Client:** `spacetimedb/src/anthropic.ts` → `callAnthropicJson(ctx, { system, user, schema, effort, maxTokens })`. Raw HTTP (`POST /v1/messages`, `anthropic-version: 2023-06-01`), because procedures can't run the SDK. JSON comes from structured outputs (`output_config.format = { type: "json_schema", schema }`, GA, no beta header), so the schema must use the supported subset: `additionalProperties: false` on objects, every field required, no `minimum`/`maxLength`-style constraints. No `temperature`/`top_p`/`top_k` (400 on this model). Haiku 5.5 thinks adaptively by default, so the answer is read from the `text` block(s), not `content[0]`.
- **Effort / limits:** extraction `effort: medium`, `max_tokens: 8000`; summary `effort: low`, `max_tokens: 4000` (thinking counts toward `max_tokens`).
- **Failures:** `AnthropicError.kind` is `http` (network error or non-200), `refusal`, `truncated` (`stop_reason: max_tokens`) or `parse`. `http`/`truncated`/`parse` are retried after 10/30/90 s, then dropped (the next turns schedule a fresh window). A `refusal` is not retried: Haiku has no server-side fallback and the same input gives the same answer, so the window is skipped (cursor advances, nothing written) and a refused summary is simply missing.
- **Measured (2026-10-25, local, real Haiku 5.5):** extraction call 2.1–4.6 s (≈1.8–1.9k input / 350–830 output tokens), session summary 3.2 s (≈0.5k / 0.2k). Each call logs model, latency and token usage (`spacetime logs`).

## Running on Maincloud (hosted SpacetimeDB)

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

## Voice runtime

The Cartesia/SpacetimeDB voice runtime is now included alongside the text-only tutor. See [animated voice canvas integration](docs/VOICE_CANVAS.md) and [voice setup](docs/VOICE_RUNTIME.md). The voice client uses port 5175; its `?canvasPreview` route works without microphone access or API keys. Use `pnpm dev:voice` for the whole stack; voice and typed lessons share one session screen.

## Abdul + voice integration branch

See [the separate integration checkout guide](docs/ABDUL_VOICE_INTEGRATION.md) for the merged streaming lessons, speech-synced cut-and-slide proof, local ports, and key configuration.
