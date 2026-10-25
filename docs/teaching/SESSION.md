# Integrated lesson session

**Current provider and voice API:** see [Anthropic streaming and voice integration](VOICE.md). Anthropic is the default; Codex below refers to the legacy opt-in bridge. `TeachingSession` now supports `{playback: "voice"}` in addition to the text flow described here.

The main app at `http://127.0.0.1:5173/` integrates the teaching planner with the latest visual engine. `npm run dev` is sufficient for the three offline lessons. There is no microphone, speech service, model service, or secret required for those samples. The default question input now uses the real Codex-backed model; see [LOCAL_MODEL.md](LOCAL_MODEL.md) for setup without an API key.

## What the product does now

The learner chooses a sample topic, receives a diagram and a short explanation, and answers directly. A response is assessed, recorded, and immediately used to plan the next teaching step. Help requests can simplify the explanation or switch representations. A learner can manipulate permitted objects or quantities before submitting an answer. The planner receives the actual resulting canvas, not the original lesson template.

The layout is shared across topics: a visual workspace, a tutor conversation, response controls chosen by check type, a saved original question, and collapsible lesson notes. The catalog is sample content; it is not a whitelist in the planner. A host model can return any supported visual vocabulary for an arbitrary topic using the same UI. New arbitrary simulations still require new renderer capabilities.

Default UI lives in `src/teaching/ui/LessonWorkspace.tsx`; scoped visual styling is in `lesson.css`. `src/app/App.tsx` retains the lesson while switching to development tools.

## Text-mode coordinator

```ts
import { TeachingSession, createHttpPlanningModel } from "./src/teaching";

const session = new TeachingSession(
  {
    sessionId: crypto.randomUUID(),
    age: 9,
    topic: "Why do shadows change during the day?",
    originalQuestion: "Why was my shadow longer in the morning?",
  },
  createHttpPlanningModel("/api/teaching/plan"),
);

await session.plan(); // validate and display the first beat as text
session.presentNext(); // only if planner.status === "presenting"
await session.respond({ kind: "answer", text: "My explanation…" });
// respond assesses the answer and requests the next plan automatically.
```

`TeachingSession` is intentionally a **text rehearsal coordinator**. Each beat's visual cues are applied immediately through `narrationStarted` and `narrationEnded`; there is no invented speech duration. For multi-beat steps, Continue reveals the next beat. Responses unlock only after the final beat completes. A no-check explanation waits for Continue rather than racing through several turns.

| API | Behavior |
| --- | --- |
| `planner`, `director` | The authoritative underlying instances; snapshots are read-only by convention. |
| `getSnapshot()`, `subscribe()` | Coordinator state: busy, error, displayed beat index, accepted edit count. Subscribe to planner/director separately for lesson/visual changes. |
| `plan()` | Capture versioned context, ask the injected model, validate, then display the first beat. Returns success/failure; errors remain visible in snapshot. |
| `presentNext()` | Reveal the next text beat, guarded against intervening canvas changes. |
| `respond(response)` | Assess against the current canvas, record evidence, and request the next step. |
| `canInteract()` | Requires a completed presentation, pending learner response, and no pending plan. |
| `interactMath(action)`, `interactActivity(action)` | Route edits through the latest director token and revision checks; return accepted events or null. Edits alone are not assessment submissions. |
| `cancel()` | Abort planning, invalidate late results, discard unfinished presentation, preserve the visible canvas. Call on departure/unmount. |

`plan()` captures `contextVersion` before the async request and checks it **before planner acceptance**. This catches reset/replay even when scene JSON is unchanged. Each subsequent beat uses the version retained after its predecessor. The planner independently validates its own revision, expected scene, visual commands, teaching policy, and checks. Cancellation epochs reject late results even if the provider ignores AbortSignal.

Session memory clears on reload or choosing another topic. Browsing development tools retains the current lesson. No localStorage or remote persistence is implemented.

## Model teammate

The development server now implements the endpoint through Codex ChatGPT sign-in. Another host can implement the same contract described in [INTEGRATION.md](INTEGRATION.md). The UI offers an arbitrary topic, optional original question, and endpoint address. The HTTP adapter sends a `PlanningRequest` and expects raw `TeachingStep` JSON. An endpoint failure is shown with retry and expandable technical details; it never falls back to sample content.

The three samples inject `demoPlanningModel` and follow scripted branches. They establish integration behavior, not evidence of model intelligence or learning efficacy. Arithmetic is computed; explanation judgments from a real model remain tentative. Use trusted server-side instructions and validation rather than trusting browser-supplied prompts.

## Voice teammate: replace presentation, preserve state

Do not call the text coordinator's `plan()`/`presentNext()` to drive real speech: they complete visuals immediately. Build the playback adapter around the underlying planner/director sequence:

1. Capture `director.getPlanningContext()` and request a plan. Reject changed context before `planner.accept`.
2. Prepare one beat with its expected context version and retain `{stepId, beatIndex, token}`.
3. Speak exactly that beat's narration through Cartesia/LiveKit; forward actual start/progress/pause/completion to the director.
4. Only normal audio completion advances the beat. Only completion of the final beat calls `planner.presented(stepId)`.
5. Forward finalized learner responses to `planner.respond`; take the next plan from the current scene. Canvas edits are context until explicitly submitted.
6. On confirmed interruption, stop speech, abort planning, discard queued beats, and interrupt both planner and director. Keep the partial scene. Reject callbacks from older turns. False interruptions that resume speech need the same token and a pause/resume path.

One host owns this sequence. Do not attach a second planner or let both text mode and the voice host advance the same session. The RPC and playout contracts are in [LIVEKIT_CARTESIA.md](../LIVEKIT_CARTESIA.md). No LiveKit SDK or voice transport has been added here.

## Demo and acceptance checklist

- [x] Start Equal groups; choose `2 + 3` to trigger the intuition branch.
- [x] Select Show another way: array becomes an interactive grouping activity.
- [x] Select an object and place it in a basket; the next model request contains that placement.
- [x] Answer `six`: the next explanation reveals the linked mathematical statement.
- [x] Advance through repair, solo and transfer; return the original question unsolved.
- [x] Run decimals and water cycle through the same UI and planner to completion in automated tests.
- [x] Delayed result after identical-canvas reset is rejected; retry succeeds.
- [x] Cancelled provider results cannot replace a newer lesson; multi-beat responses are gated.
- [x] Endpoint failures remain visible without substituting scripted data.
- [x] Exercise a real generated lesson and follow-up through the no-key Codex bridge.
- [ ] Evaluate a broad set of unseen topics and model-generated checks.
- [ ] Connect and test actual Cartesia/LiveKit playback, barge-in, and reconnects.

Validation at the planner-integration checkpoint: 125 automated tests, TypeScript, main production build, and standalone teaching build. The production build retains a >500 kB bundle advisory. Manual browser checks cover adaptation, selecting/placing objects, entering a numeric word answer, and representation changes. Automated tests cover the full three-topic completion flows. Touch hardware and real audio timing remain untested.

Current real-model setup, validation count and measured smoke-test behavior are recorded in [LOCAL_MODEL.md](LOCAL_MODEL.md).
