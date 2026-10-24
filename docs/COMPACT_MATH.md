# Compact math commands and local exploration

The model chooses a mathematical representation and quantities. Renderer code owns layout, colors, geometry and equations. There is no generated JavaScript, SVG markup or CSS in the compact path. The existing full canvas contract remains available for teammate integrations and offline activities.

## Try it without a model or voice

Run `npm ci`, then `npm run dev`. On the welcome screen choose **Open math studio**. Area, Triangles, Groups, Fractions and Number line are deterministic explorations. Change a slider, drag the triangle corner, shade a bar or move a marker with arrow keys. All edits go through the existing revision-checked VisualDirector; they never call the LLM. Reset restores the chosen example.

The studio is an exploration surface, not a generated or automatically assessed lesson. For an adaptive lesson, return to All topics and enter a math question. That still uses the no-key Codex bridge and works in text mode.

## Model-facing commands

Import `CompactMathCommandSchema`, `compileMathCommand` and `CompactMathCommand` from `src/presentation/index.ts` (or the pure `src/presentation/math/compact.ts` module on the server).

```ts
const context = director.getPlanningContext();
const commands = compileMathCommand(
  { kind: "array", rows: 3, columns: 7, splitAt: 5 },
  context.canvas,
  { title: "One total, two pieces", interactive: true, showEquation: true },
);
const token = director.prepare({
  id: "split-example",
  narration: "Three groups of seven can be split into two useful pieces.",
  cues: [{ id: "show", atMs: 0, commands }],
}, { expectedContextVersion: context.contextVersion });
```

Start/finish this token immediately only in text mode. In LiveKit, use actual Cartesia playout lifecycle events as described in [LIVEKIT_CARTESIA.md](LIVEKIT_CARTESIA.md).

| Command kind | Parameters | Renderer responsibility |
| --- | --- | --- |
| `array` | `rows` 1–12, `columns` 1–20, optional `splitAt` inside the columns | Stable cells, two-part layout, multiplication and decomposition |
| `bars` | 1–4 `bars` with unique `id`, `label`, `parts` 1–12, `shaded` 0–parts | Equal wholes, partitions, exact comparison of first two bars |
| `number_line` | `min < max` within −1000…1000, 1–6 markers with `id`, `label`, `value` | Shared scale, one rail per marker, keyboard/pointer updates |
| `geometry` | `shape`: `rectangle` or `right_triangle`; `width`, `height` 1–12 in 0.5 increments | Mafs drawing, constrained corner, area and dimension labels |
| `update` | `changes`: 1–6 existing `MathChangeSchema` values | Updates current visual without resetting unrelated learner quantities |
| `keep` | No other fields | Keeps current picture; applies supplied interaction/equation permissions |

New compact representations use the ID `math`. Updates/keep use the actual current ID; the compiler rejects either without an existing math visual. New representations reset model revision; accepted learner events always carry visual ID, current revision and the director playback token. Updates/keep retain the existing visual title. A new title is applied when creating a representation.

Examples:

```json
{"kind":"geometry","shape":"right_triangle","width":6,"height":4}
```

```json
{"kind":"update","changes":[{"type":"set_geometry","width":8}]}
```

A geometry `MathAction` changes dimensions with `set_geometry`. Assessment fields `geometry_area`, `geometry_width`, and `geometry_height` read the actual state when the learner submits their work. Merely moving a control does not imply mastery. Learner events cannot reveal an equation or grant interaction permissions.

## Compact lesson generation

`src/server/compactLesson.ts` defines `CompactLessonSchema`. It carries phase, title, goal, approach, reason, short narration, one compact visual command, interaction/equation flags, check, optional separate example and tentative explanation assessment. Code supplies step/beat/cue IDs, compiles commands and appends the exact check question. `planning.ts` then runs the existing full teaching validator before returning the usual TeachingStep to the browser. Neither the HTTP response contract nor LiveKit beat/playback contracts change.

The model prompt includes this smaller schema and summarized prior steps instead of previous full command histories. The actual canvas and assessment evidence remain available. Existing full TeachingStep candidates are still validated for compatibility; the local generator is now instructed to produce compact math lessons only. General activity/free-form rendering remains available outside this generator. This is not an arbitrary simulation engine.

## Visual system

- SVG + Motion for arrays and existing manipulatives; stable object IDs preserve continuity.
- Mafs for rectangles and right triangles, centered on a fixed grid. Local dimensions snap to half-unit steps; no camera movement during dragging.
- KaTeX for model-derived equations, fractions and areas. Only code-generated numerical expressions enter TeX; labels stay React text. Hidden readable summaries provide accessible equivalents.
- Green denotes the first quantity/part; amber denotes the second. Labels and linked equation terms use the same mapping where applicable.
- Direct quantity changes avoid tween lag; narrated noninteractive array transitions retain motion, respecting reduced-motion preferences.
- Mafs and KaTeX load on demand. The first geometry/equation can need a module download; subsequent manipulations require no network.

## Verification and limits

- 144 tests, TypeScript, main production build and standalone teaching build passed.
- Browser checks: rectangle slider changed area 24 → 32; dragged triangle changed dimensions 6×4 → 10×6 and area 12 → 30; moving an array split preserved total 21; shading produced 2/4 = 4/8; keyboard moved number-line A from 0.3 → 0.4.
- Browser generation also produced a fresh split-array diagnosis for “Why is 3 times 7 the same as 3 times 5 plus 3 times 2?” through the compact endpoint, with an explanation input and no revealed equation.
- The serialized output schema decreased from 23,814 to 7,601 characters (68%). This measures schema characters, not tokens or end-to-end latency.
- A real two-turn test asked why doubling a rectangle's width doubles area: first diagnosis ~8 seconds, then a request for simpler explanation completed at ~16 seconds total. The earlier free-form test was ~22 seconds initially and ~54 seconds total on a different topic. These are individual observations, not a controlled benchmark or latency guarantee.
- New model reasoning still takes time. This change does not implement persistent model sessions, incremental model streaming, speculative lesson branches, LiveKit transport or Cartesia playback.
- Geometry currently covers rectangles and right triangles, not arbitrary constructions or function plots. Other math concepts must fit supported representations or use a verbal explanation.


## Generated visual sequences

A compact lesson now has an optional `sequence` of up to three additional moments. The initial `narration`, `visual`, `showEquation` and `interactive` describe the first moment; each sequence entry supplies those four fields for the next one. The compiler applies each command to the preceding canvas, preserving object IDs and changes. Intuition and worked examples require at least two moments. A diagnostic prediction or independent task stops before showing its answer.

Example continuation after a rectangle has been shown:

```json
"sequence": [
  {
    "narration": "The width grows from 3 to 6. Both rows gain three squares.",
    "visual": {"kind":"update","changes":[{"type":"set_geometry","width":6}]},
    "showEquation": false,
    "interactive": false
  },
  {
    "narration": "The height stays at 2, so doubling the width doubles the number of squares.",
    "visual": {"kind":"keep"},
    "showEquation": true,
    "interactive": true
  }
]
```

The model chooses the quantities, explanation, transformations, and final check using the learner's question, current canvas, and evidence. This is still a bounded mathematical command language, not arbitrary generated code or a general-purpose video engine. A new explanation needs inference; progressing through its moments, replaying it, and manipulating the resulting picture do not.

### Text playback

The browser plays the already-validated beats in order, allowing roughly 270 ms per word with a 3.5–12 second reading window per beat. Pause holds the current moment, Next advances immediately, and Replay restores the initial canvas and repeats the commands without a model call. Replay resets edits to that picture. The final question and learner controls appear only after every moment has been presented. Reduced-motion preference disables visual interpolation and starts playback paused for manual advancement. Leaving a lesson clears playback timers.

Geometry interpolates its dimensions from a fixed corner over one second, leaving the previous rectangle as a dotted reference during that run. Replay starts a new renderer run so that an old result cannot remain as a ghost outline in the starting picture. Arrays animate their cells and split; bars animate repartitioning; number-line positions interpolate while observing. Direct learner manipulations remain local.

The text timer is a reading aid, not audio synchronization. The LiveKit host must use actual narration start/end events to advance beats. Do not run text autoplay alongside voice playback.


### Verification of generated flow

On 2026-10-24, the real Luna bridge generated an area prediction followed by a two-moment explanation after the learner said widening adds only three squares. The explanation kept height 2, changed width 3 to 6, and correctly described six additional squares. The two requests took approximately 7 and 5 seconds.

A second topic, splitting 4 × 8 into 4 × 5 + 4 × 3, produced a three-moment response to the claim that splitting creates extra squares: show the split, remove it while retaining all 32 cells, and restore it with the equation. The prediction took about 5 seconds and the explanation about 15 seconds, including any bounded validation repair. These are observations, not benchmark guarantees. New explanation latency is still material.

The server requires an assessment of the latest explanation before choosing its next step. An assessed misconception after diagnosis must move to an intuition demonstration, preventing a repeated diagnostic-still loop. Unclear responses can still receive clarification. This remains a tentative model assessment, not proof of mastery.

Automated coverage includes sequential compilation, invalid intermediate commands, final-question placement, local replay without another model call or evidence, resetting learner edits on replay, timed progression, pause, restarting the reading interval on replay, and timer cleanup when leaving the lesson.
