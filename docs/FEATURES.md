# Implemented visual-engine features

This inventory describes the `feature/visual-engine` branch. The preview runs locally without a backend. The engine consumes structured configuration; it does not yet contain the live tutor/LLM or LiveKit transport.

## Real-time configuration

| Implemented feature             | What works now                                                                                                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live tutor controls             | Change the active example through validated commands without restarting the app. The inspector can edit a model before learner controls are enabled.                                                                                                                    |
| Array configuration             | Rows, columns, split position, part focus, linked equation visibility, and learner permission. The inspector clears incompatible focus/split state when shrinking an array.                                                                                             |
| Bar configuration               | Each bar's parts and shaded count, focus, derived comparison, and learner permission. Inspector changes to parts also bound the shaded count; raw engine commands instead reject inconsistent values.                                                                   |
| Number-line configuration       | Marker positions, focus, scale, derived numeric statement, and learner permission. Both scale endpoints are applied together; markers must remain in range.                                                                                                             |
| Examples based on current state | `createMathExample(currentVisual, intent)` creates a smaller-number example or a quantity variation. It reads the latest model, including learner edits, preserves identity, and validates its output. These are deterministic local rules, not a diagnosis of mastery. |
| Detached planning context       | `getPlanningContext()` returns a serializable copy of the current canvas, lifecycle status, token, and monotonic `contextVersion`.                                                                                                                                      |
| Stale plan rejection            | `prepare(beat, {expectedContextVersion})` rejects a plan based on outdated learner or explanation state before replacing anything. Existing callers can omit the guard; asynchronous agents should always supply it.                                                    |
| Accepted learner context        | Math/activity change events include the resulting scene and `contextVersion`, so the agent can react to actual learner work.                                                                                                                                            |
| Configuration beyond controls   | JSON plans can supply new titles, labels, objects, representations, and narration. Unknown fields or unsupported configurations fail validation.                                                                                                                        |
| Script/manual separation        | Live edits move the preview into custom configuration. The remaining fixed rehearsal script is stopped so it cannot narrate obsolete quantities. Notes update with live edits.                                                                                          |

## Mathematical representations

| Representation                   | Implemented operations and bounds                                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arrays and area-style partitions | 1–12 rows × 1–20 columns; up to 240 cells. Add/remove rows or columns, divide columns into two parts, focus either part, animate stable cell identities.                |
| Derived multiplication statement | Product and distributive decomposition calculated from the same model as the cells. Show/hide the statement.                                                            |
| Equal-whole bars                 | 1–4 bars, each with 1–12 equal parts. Colour/clear amounts and repartition. Exact rational comparison of the first two bars.                                            |
| Number lines                     | 1–6 named markers, bounded by a common scale within −1000…1000. Each marker currently has its own rail on that scale. Change scale, move markers, highlight one marker. |
| Learner manipulation             | Array sliders; bar shading and part selection; marker dragging, arrow buttons, keyboard arrows and Home/End.                                                            |
| Canonical quantities             | Diagrams and linked statements derive from the same state; there is no independently generated answer string for mathematical statements.                               |

## Other interactive activities on the same canvas

- **Objects and groups:** drag tokens between containers, select/tap to place, return to tray, and live counts.
- **Sorting:** configurable items/categories, placement, return, and ordering.
- **Diagrams and sequences:** move/reorder nodes, add or remove directed connections, and label relationships.
- **Shapes:** move, rotate, reflect, and inspect against a mirror guide.
- **Activity updates:** change configuration while preserving surviving placements, selection, highlights, and order by stable ID, or explicitly replace/reset the activity.
- **Tutor attention:** highlight activity objects through revision-checked commands.

These reuse the existing `LearningWorkspace` components inside `TeachingCanvas`. The standalone component workbench remains available for isolated testing.

## Free-form diagram vocabulary

The SVG scene supports labelled icons, text, circles, rectangles, triangles, arrows, highlights, pointer labels, and explanatory notes. Commands: `clear`, `add`, `update`, `remove`, `connect`, `highlight`, `point`, and `note`. Positions use a 1000 × 600 coordinate space. Object movement, rotation, entrances/exits, and connections animate; not every arbitrary style/size property has a continuous transition.

A canvas hosts one main representation at a time: generic objects, a math model, or a legacy activity. `show_math` / `show_activity` replace the active representation. `update_math` / `activity_command` modify it. Simultaneous multi-panel representations are not implemented.

## Explanation and playback lifecycle

- Prepare a whole `VisualBeat` without drawing it; preflight all cues and references.
- Apply cues against an audio/playback clock; repeated cues and backwards progress are ignored.
- Start, progress, pause/resume, normal completion, interruption, and replay.
- Normal completion applies any remaining cues. Interruption keeps the visible picture and cancels pending cues.
- Fresh playback tokens distinguish repetitions of the same beat; delayed callbacks cannot alter a replacement run.
- Replay restores the scene from before the current beat, including undoing changes made during that beat.
- Optional free-form object-choice questions with one accepted response after narration ends.
- Math/activity exploration after completed narration, gated by explicit interaction permissions.
- Reference HTML audio adapter and committed recordings for water-cycle and equal-group rehearsals.

## Validation and interaction safety

- Strict Zod schemas for visual plans, mathematical models, changes, activity state, and learner actions.
- Transactional cue batches: a rejected batch does not leave a partial scene.
- Invalid plans preserve the active drawing and explanation.
- Mathematical bounds, unique IDs, valid references, in-range shading/markers, and compatible operation types.
- Learner event revision checks, duplicate rejection, wrong-scene/model rejection, and stale playback-token rejection.
- Learner actions cannot grant permissions or reveal equations; those are tutor commands.
- Pointer gestures can be cancelled; keyboard/tap alternatives are provided.
- JSON data only: generated JavaScript/HTML is not evaluated.
- Reduced-motion handling and labelled controls. Touch hardware has not been manually verified.

## Local testing and presentation

- A compact workspace replaces the large slogan and decorative hero.
- Neutral surfaces, sharper geometry, restrained typography, and blue/orange labels distinguish array parts.
- The mathematical canvas stays visible beside the controls on wide screens; a stacked layout supports narrow screens.
- Step-through rehearsals for multiplication, equivalent fractions, decimals, and existing activities.
- Custom starting quantities, live editing, and current-state example variants.
- JSON plan editor with manual playback/cue controls, pause, interruption, and replay.
- Inspectable canvas snapshot and accepted learner-event log; browser memory only.
- TypeScript checks, production build, and 84 automated tests at this update. Browser checks cover live edits, state-based example generation, diagrams, equations, bar quantities, number-line keyboard controls, and invalid-plan handling.

## Not implemented yet

| Capability                                 | Remaining work                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live tutoring                              | LLM planning, understanding arbitrary spoken requests, assessment, misconception diagnosis, and pedagogical decisions.                                              |
| Voice transport                            | LiveKit room integration, server tokens, Cartesia speech, RPC handlers, ordered lifecycle transport, and actual audio synchronization. The interface is documented. |
| Autonomous adaptation                      | Automatically selecting the best next example from a learner's response. Current example variants require a button/API call and use fixed rules.                    |
| New mathematical families                  | Symbolic algebra, balance models, graphs/functions, freehand recognition, continuous simulations, and other custom representations.                                 |
| Cross-representation reasoning             | Automatic conversion between an array, number line, and bar model while preserving a pedagogical explanation.                                                       |
| Media/input and persistence                | Homework image ingestion, accounts, session storage, analytics, and saved learner progress.                                                                         |
| Production performance/accessibility audit | Full device coverage, touch-hardware verification, and bundle optimization. The build currently reports a bundle-size advisory.                                     |

See [MATH_CANVAS.md](MATH_CANVAS.md) for exact commands and [LIVEKIT_CARTESIA.md](LIVEKIT_CARTESIA.md) for teammate integration.
