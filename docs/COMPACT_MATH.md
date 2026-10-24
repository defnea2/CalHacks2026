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
