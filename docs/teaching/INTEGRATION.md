# Teaching and activity planner — Member 3

This module plans the next teaching turn, configures the existing visual engine, checks learner responses, and chooses the next teaching phase from recorded evidence. It supports general topics through an injected model. The offline harness has three explicitly scripted fixtures; those fixtures are test data, not a general AI tutor.

Branch: `feature/teaching-planner`. Base: visual-engine commit `790505e`. Development checkout: `../CalHacks2026-teaching-planner`. Existing visual renderer, presentation director, shared contracts and app entry point are unchanged. This branch adds `src/teaching/`, a separate HTML/Vite entry point, scripts, and this guide. Merge the branch when ready; do not copy its older visual-engine files over newer work.

## Run it independently

```sh
npm ci
npm run dev:teaching
# Open http://127.0.0.1:5174/teaching.html
npm run test:teaching
npm run check
npm run build:teaching
```

The harness uses port 5174 with strict port selection, leaving the visual-engine development server alone. Its production output is `dist-teaching/`. No new dependencies or provider credentials are needed for fixtures.

Try: plan a diagnostic question → choose a wrong answer → plan the intuitive explanation → request **Show another way** → plan again. The multiplication fixture changes an array into objects and baskets. Correct answers progress through separate practice and transfer problems; the original question is left for the child. Decimal comparison and the water cycle demonstrate that teaching is not restricted to one mathematical topic. Fixture practice is finite and reports exhaustion instead of silently claiming to generate new material.

The harness displays speech as text and applies each beat immediately through the real `VisualDirector`. It does not test audio latency or speech/visual synchronization. Multiple beats require **Present next beat**. Canvas changes are only scored after **Submit my canvas**.

## Ownership and integration boundaries

| Component | Responsibility |
| --- | --- |
| Teaching planner | Teaching phase, structured next step, check rules, evidence and recap |
| Existing LLM/voice host | Model calls, STT, conversation turn-taking, Cartesia through LiveKit, interruption |
| Visual engine | Validated canvas commands, actual canvas state, presentation and learner controls |
| Context owner | Topic, age, original question, selected source snippets, persistence |

There is **one conversational tutor**. The planner supplies `beats[].narration` to the voice host; do not run a second free-form response alongside it. Cartesia provides speech, not the teaching plan. The planner is transport-independent TypeScript and does not instantiate another LiveKit agent.

## Public contract

Import from `src/teaching/index.ts`. Version is `TEACHING_VERSION = 1`. Zod schemas in `contracts.ts` are the source of truth; existing `VisualBeatSchema` supplies the exact visual command schema.

Session configuration:

```ts
const planner = new TeachingPlanner({
  sessionId: "lesson-123",
  age: 9,
  topic: "Why is 0.4 larger than 0.35?",
  originalQuestion: "Which is larger: 0.8 or 0.75? Explain why.",
  context: [
    { id: "homework-1", text: "Comparing decimals to hundredths", source: "worksheet" },
  ],
});
```

Age defaults to 9. There are at most 12 context snippets, each at most 3,000 characters. Context is supplied data, not an instruction source. This implementation takes context at session creation; dynamic retrieval/context refresh and durable session storage belong to the integration layer and are not implemented here.

The model adapter is intentionally small:

```ts
type PlanningModel = (
  request: PlanningRequest,
  signal?: AbortSignal,
) => Promise<unknown>;
```

`PlanningRequest` includes `version`, `requestId`, `basedOnRevision`, `systemPrompt`, `responseSchema`, and `context`. Context includes session configuration, current step, recent steps, previously used examples, observed evidence, allowed next phases, and the **actual canvas snapshot**. When the latest response is an unassessed explanation, `phaseOptionsAfterAssessment` supplies allowed transitions for each tentative judgement.

Return one `TeachingStep` object, not Markdown or an envelope:

```json
{
  "id": "diagnose-1",
  "phase": "diagnose",
  "learningGoal": "Interpret multiplication as equal groups",
  "approach": "introduce",
  "rationale": "Check the starting idea before explaining.",
  "beats": [{
    "id": "diagnose-1-beat",
    "narration": "Which describes two groups of three?",
    "cues": [{
      "id": "clear-1",
      "atMs": 0,
      "commands": [{ "type": "clear", "title": "Think about equal groups" }]
    }]
  }],
  "check": {
    "kind": "choice",
    "prompt": "Which describes two groups of three?",
    "options": [
      { "id": "twice", "label": "3 + 3" },
      { "id": "labels", "label": "2 + 3" }
    ],
    "correctOptionId": "twice"
  },
  "evidenceToObserve": ["Recognizes repeated equal groups"],
  "assessment": null
}
```

Use unique step and beat IDs, up to four beats, and one question at a time. The final narration must contain `check.prompt`. Do not also set `VisualBeat.question`. Worked examples and independent checks need `exampleProblem`; the handoff uses `phase: "return_to_problem"`, `approach: "handoff"`, `check: null`.

## Connect the existing model

The host can inject its existing model directly, or implement `POST /api/teaching/plan` for `createHttpPlanningModel()`. The HTTP adapter sends the complete `PlanningRequest` and expects the raw `TeachingStep` JSON. **This branch does not implement that server endpoint or call a live LLM.** Selecting Model endpoint in the harness requires a running backend; failure remains visible and does not fall back to fixtures. A different-origin backend must configure its own CORS/authentication.

On the server, use trusted copies of the teaching instructions/schema and validated session context; do not treat browser-provided system instructions as authority. Pass the response schema using your provider's structured-output facility where supported. Provider schema restrictions may require adapting the generated JSON Schema. Regardless of provider, the runtime acceptance check remains mandatory: JSON Schema alone does not enforce cross-field refinements, evidence policy or canvas references.

```ts
const step = await planner.generate(
  existingModelAdapter, // implement PlanningModel using your chosen LLM
  director.getSnapshot().canvas,
  () => director.getSnapshot().canvas,
  abortController.signal,
);
// step is now validated and the planner is in "presenting".
```

Alternatively use `request(canvas)` → model call → `accept(requestId, output, currentCanvas)` explicitly. Invalid responses leave the prior teaching state intact. Retry with a fresh request and bounded host retry policy; don't speak unvalidated output. Older requests, changed planner revisions and changed canvases are rejected. `getSnapshot()` is a read-only-by-convention view; never mutate its arrays/objects.

## LiveKit + Cartesia handoff

These are integration callbacks, not claims about a particular LiveKit SDK version. If the voice server is Python, exchange the JSON request/step through the host endpoint while this TypeScript runtime coordinates validation and presentation. Do not port a second incompatible schema by hand.

For each accepted `step`, present its beats **sequentially**:

1. `token = director.prepare(beat)`.
2. Ask the voice host to speak exactly `beat.narration` through Cartesia/LiveKit, associating it with the step ID, beat ID and playback token.
3. On actual playback start, call `director.narrationStarted(token)`.
4. If reliable audio progress exists, call `director.narrationProgress(token, elapsedMs)`. Until alignment is wired, use short phrases and one visual cue at `atMs: 0`; don't estimate speech timing from token generation.
5. On normal playback completion, call `director.narrationEnded(token)`. Check for director errors before advancing.
6. After the last beat actually finishes, call `planner.presented(step.id)`. The planner then waits for a response if there is a check, or allows another plan. It completes only at the original-question handoff.

Do not acknowledge presentation when TTS is merely requested or generated. A stale completion callback must not advance a newer step. The visual director's tokens and the planner's step IDs provide these checks; the host must keep their association.

On barge-in during presentation: stop the queued speech, discard remaining beats, abort outstanding planning, call `director.interrupt(token)` and `planner.interrupt(step.id)`. Preserve the actual partially presented canvas for replanning. Carry the interruption text into the host's next model call as untrusted learner context; a partial presentation is not an answer to a completed check. The planner currently records check responses only after `presented`, so the host must distinguish interruption intent from assessment evidence.

## Learner responses

After normal presentation finishes:

```ts
planner.respond({
  eventId: "utterance-456", // stable ID for delivery retries
  stepId: step.id,
  response: { kind: "answer", text: finalTranscript },
}, director.getSnapshot().canvas);
```

Response variants:

| Kind | Payload | Use |
| --- | --- | --- |
| `answer` | `text` | Final numeric transcript or explanation |
| `choice` | `optionId` | Recognized selected option |
| `interaction` | No extra fields | Explicit submission of current canvas |
| `help` | `request: simpler / another_way / hint / repeat` | A change in teaching approach |

Only submit finalized utterances. Numeric parsing accepts numbers and simple English phrases such as “twenty-four” and “zero point three five”; ambiguous sentences remain unclear. For a spoken choice, the voice host must map the utterance to an existing option only when unambiguous, otherwise clarify. UI edits go through `director.interactMath` / `interactActivity`; they are not automatically answers. Send `interaction` only when the child submits or clearly says they are done.

Repeated delivery of an identical event is idempotent. Reusing its ID for a different payload is rejected. Responses for an inactive/unfinished step are rejected. After `respond`, request the next step using the latest canvas and evidence.

## Teaching policy and checks

Phases are a flexible subset of: diagnose → intuition → formalize → worked example → repair → solo → transfer → original-question handoff. A wrong response permits prerequisite explanation or repair; an unclear response stays on the current question. Correct evidence permits advancement. Help can retain the phase or revisit intuition. A representation change must actually change the rendered family.

Checks support numeric arithmetic, explicit choices, math quantity/marker manipulation, object placement, ordering, and explanation rubrics. Arithmetic is computed in code. Choice and activity checks compare against an authored rule; that does **not** independently verify whether the model authored a factually correct rule. Explanation interpretation is labelled `model_tentative`, cites the latest explanation evidence, and cannot overwrite a deterministic result.

All visual commands are preflighted on a clone before acceptance. References must exist and interaction controls must be enabled. Independent math checks cannot display derived equations, including temporarily before a later cue hides them. Fresh independent examples and exact original-question reuse are checked. Semantic answer leaks through prose, labels or paraphrases, the pedagogical suitability of activities, and every interaction target's reachability still require model evaluation; schema validation is not a guarantee of teaching quality.

`recap()` returns actual evidence, exact independently checked examples passed, and `needsMorePractice` (historical incorrect observations, **not** an automatically resolved mastery diagnosis). Tentative interpretations and assisted answers do not count as independent passes. No broad mastery percentage is invented.

## Limits and remaining integration work

- In-memory state only: 80 steps and 160 evidence events per session. Model requests include the last 8 steps and last 20 evidence items, plus all used example strings.
- General planning depends on the host model endpoint; live model output quality and latency have not been evaluated in this branch.
- Voice/context owners still need to connect finalized transcripts, audio lifecycle callbacks, context retrieval, persistence, and the model adapter.
- The existing canvas determines the supported visual vocabulary. Arbitrary executable HTML/JS or generated simulations are outside this contract.
- The phase sequence is a product design informed by the team's suggestion, not a measured claim of improved learning or recall.

## Checkpoints for integration

- [x] Validated teaching/assessment contracts and evidence-driven phase policy.
- [x] Independent harness that renders through the existing visual engine.
- [x] Correct, incorrect, ambiguous, help, stale-result and cancellation paths covered in tests.
- [x] Model adapter boundary and voice/context handoff documented.
- [ ] Connect the host LLM and run unseen topics through real structured output.
- [ ] Connect Cartesia/LiveKit playback and finalized learner responses; test barge-in.
- [ ] Connect real worksheet/context input and retain evidence across reconnects.
- [ ] Rehearse the complete diagnosis → alternate explanation → independent transfer → original-question demo.
