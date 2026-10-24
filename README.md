# Interactive visual engine

Our visual module for a general tutor for ages 7–9. This branch contains only the engine, its local scene types/state helper, tests, and a minimal preview. It does not scaffold the other teammates' voice, teaching, or product work.

## Run

Use Node 22.12+ and npm:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. No API keys, backend, microphone, or model are required.

## Integration seam

```tsx
<LearningWorkspace scene={scene} onAction={handleLearnerAction} />
```

The host owns scene state. The engine renders validated data and emits revision-tagged learner actions. `src/shared/contracts.ts` defines this module's types. `src/session/sceneReducer.ts` is an optional reference implementation for validating and applying events, used by the preview. Other teammates can integrate through this seam without adopting a team-wide app architecture.

## Features

- Objects/groups and sorting
- Bars and number lines
- Diagrams and sequences
- Shape transformations
- Stable object IDs, bounded actions, stale-command rejection, and updates that preserve valid learner work

The local fixtures are examples of the reusable components, not a topic limit or an AI planner.

## Verification

```sh
npm run check
```

Feature commits on `feature/visual-engine` keep the implementation traceable. The earlier `scaffold/shared-contracts` branch is separate and is not required for this module.
