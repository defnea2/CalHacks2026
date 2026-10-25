# Hackathon visualization recommendations and handoff

Date: 2026-10-24

## Implementation status (2026-10-24)

The first slice is built and verified: a deterministic primitive plus live tutor integration, as a standalone featured lesson.

Files:
- `src/visual-math/shear.ts` (+ test): geometry (parallelogram, wedge, remainder, translated wedge, reassembled rectangle) and the phase reducer. Every learner-visible change increments `revision`.
- `src/presentation/math/ShearProof.tsx`, `shear.css`: SVG renderer, top-edge drag handle (pointer, arrows, Home/End), and a rAF-driven 1.6 s slide of the same wedge polygon. Reduced motion settles at once.
- `src/teaching/ui/SlantLesson.tsx` (+ test): learner flow, slider alternative, reveal card, tutor conversation, replay, a different slant, start over. Linked from `LessonWorkspace` as a featured card.
- `src/teaching/shearTutor.ts`: request/reply schemas, `ShearTutorConversation` (one live request, drops replies whose request id or lesson revision is stale), labeled offline fallback.
- `src/server/shearTutor.ts` (+ test), `teachingPlugin.ts`: `POST /api/teaching/shear-feedback`, Anthropic structured output, server-computed facts (area, slanted side).

Verification:
- Acceptance checks 1–8 are covered by unit/component tests (`npm test`: 191 passing; typecheck and build pass).
- Check 9: in a headless browser against the live Anthropic key (claude-haiku-5-5), the full flow ran: drag to shear 4, cut, slide (wedge offset 2.09 mid-slide, 6.00 at rest), reveal, then a live reply to a "bigger" prediction and a transfer question after the learner's explanation. Ran at 1280 px and 390 px with no horizontal overflow and no console errors. Reduced-motion and keyboard paths also checked.

Generated-lesson integration (second slice):
- `parallelogram` is a `MathVisualSchema` kind with `base`, `height`, `shear`, `stage` (`slant | cut | reassembled`) and a `set_parallelogram` change; compact commands, `mathSummary`, KaTeX statement, deterministic examples and `parallelogram_area`/`parallelogram_shear` checks support it. `MathWorkspace` renders it with `ShearProof`, which now takes plain props (shape, stage, draggable, animate, showArea) shared with `SlantLesson`.
- `VisualDirector` lets learners change only `shear`, only on stage `slant`.
- Planner instructions describe the predict-then-prove sequence. The prediction reaches the planner as ordinary choice evidence.
- Planning had been failing against the live API before this work: Zod's `oneOf` is unsupported, and the lesson grammar exceeds the compiled-size limit even without the new kind. `anthropicModel.ts` now sends the exact schema in the system prompt, validates locally, and repairs once only when nothing has been emitted. `exampleProblem: null` is accepted as absent.
- Live check (claude-haiku-5-5, topic "Does slanting a rectangle make its area bigger?"): the planner chose `parallelogram` 4 × 3 with shear 2 and a bigger/smaller/same choice. After "Gets bigger" it planned slant → cut → reassembled with the equation on the last moment. The UI rendered the proof with no console errors.

Outstanding:
- The slant tutor's `understanding` field is returned but not shown or stored as evidence.
- The standalone lesson fixes base and height at 6 × 4.
- Live narration quality varies: one diagnose narration repeated a sentence. No broad model-quality evaluation yet.

Live reliability notes (two-step runs: plan, answer the prediction, plan again):
- Early Haiku runs failed on planner policy rules, not schema: `change_representation` while keeping the same picture, a `math_value` check on the finished proof, and an intermittent "Incomplete lesson stream". Fixes: explicit parallelogram instructions (approach `continue`, end on `reassembled`, no `math_value` after the cut), a clearer validator message for the repair request, tolerance for code fences and trailing text, and a whole-reply fallback when keys arrive out of order before anything is emitted.
- After the fixes: Haiku 5.5 slant 4/4 full slant → cut → reassembled. Earlier runs before the last parser fix: Haiku multiplication 2/2 and 8/8 first steps; Sonnet 5.5 slant 3/3 after the instruction fix.
- Validation failures after narration has started cannot be repaired by design.

Exact next step: run a larger live sample (for example 20 two-step runs across array, bars, number line, geometry and parallelogram topics) and log any validator rejections.

## Status and user preferences

- Research and technical review are complete. The initial research performed no implementation; see the implementation status above.
- The recommended next build is a draggable area demonstration with a visible cut-and-reassembly proof.
- The user wants a standout hackathon experience and lower usage: delegate substantive work to cheaper agents, with the primary agent judging and steering.
- The research team used two GPT-6 Luna agents and one GPT-6 Sol agent. Claude/Opus was not available through this session's agent tools.
- The user requested a handoff before approaching usage limits. Keep this document current during subsequent work; account-level remaining usage is not visible to the agent.
- This document records a recommendation, not a completed feature or a guarantee of winning. The latest user instruction was to save these findings.

## Recommended experience: Does slanting a shape make it bigger?

Build a tutor experience in which the student predicts, manipulates, and sees a mathematical explanation unfold through the same objects.

1. Show a rectangle and ask whether slanting it will increase, decrease, or preserve its area. Collect a prediction before revealing the area result.
2. Let the student drag the top edge sideways, turning the rectangle into a parallelogram. Keep the base and perpendicular height visually clear.
3. Cut off the left triangular wedge and slide that exact piece to the right. The remaining shape and translated wedge form a rectangle. Nothing is added, removed, or resized.
4. Reveal the area relationship and give the tutor the student's prediction and actual interaction state. Its follow-up should address the student's reasoning.
5. Offer replay and another attempt without requiring a model call for the manipulation or animation.

The main visual moment is the moving proof. A fixed area counter alone states the answer; unchanged pieces reassembling make conservation visible. This exact experience's hackathon appeal is a design judgment, not an established research finding.

## Proposed demo sequence

- Opening: one short prediction question and one large shape.
- Interaction: the student makes a prediction and drags the shape into an exaggerated slant.
- Reveal: the student triggers the cut-and-reassembly animation.
- Adaptation: the tutor responds to the recorded prediction and observed action, then asks the student to explain or try a related example.

Aim for a focused 60–90 second presentation. This is a presentation target, not a latency guarantee. Do not disguise a recorded or scripted fallback as live model adaptation.

## Technical direction

Reuse React, SVG, Motion, and the existing mathematical state/teaching infrastructure. Do not replace the rendering stack for this slice.

The current geometry model supports rectangles and right triangles. Shear and moving cut pieces are new capabilities; the existing model cannot express them unchanged.

Start with one deterministic SVG component and explicit animation phases:

`prediction -> exploration -> cut -> translation -> explanation`

Use fixed positive base `b`, fixed positive height `h`, and horizontal shear `s`, constrained to `0 <= s <= b`. In mathematical coordinates, the parallelogram vertices are:

`(0, 0), (b, 0), (b + s, h), (s, h)`

The left triangular wedge has vertices:

`(0, 0), (s, 0), (s, h)`

Translate that wedge by `(b, 0)`. Together with the remaining piece, it fills the rectangle `[s, b + s] x [0, h]`, with area `b * h`. Account for SVG's downward y-axis when mapping these coordinates to the display.

- Preserve the wedge's geometry and appearance during translation; do not substitute a crossfade for the proof.
- Freeze shear input during reassembly so the pieces remain consistent.
- Use a continuous shape fill and clear cut seam. Deforming square tiles could confuse what is being counted.
- Include keyboard or slider alternatives to dragging and honor reduced-motion preferences.
- Keep drag updates, mathematical results, and replay local and deterministic.
- Integrate a bounded visual kind and compact command into generated lessons after the primitive works. Pass prediction and learner state into the actual tutor pipeline.
- A prediction alone does not establish mastery. Ask for an explanation or transfer attempt.

The technical reviewer rated this a medium-effort addition, with no elapsed-time estimate. A standalone visual is only the first slice; adaptive tutor integration remains necessary for the complete proposed experience.

## Relevant existing code and documentation

- `src/presentation/math/GeometryPicture.tsx`: current Mafs geometry rendering.
- `src/presentation/math/MathWorkspace.tsx`: math visual rendering and learner controls.
- `src/presentation/math/models.ts`: bounded math visual and action schemas.
- `src/presentation/math/compact.ts`: compact command compilation.
- `src/presentation/VisualDirector.ts`: playback, validated commands, and planning context.
- `src/presentation/TeachingCanvas.tsx`: teaching surface.
- `src/teaching/ui/LessonWorkspace.tsx`: learner lesson experience.
- `docs/COMPACT_MATH.md`: compact command contracts, generated sequences, current limits.
- `docs/FEATURES.md`: implemented feature inventory.

These were the relevant files during research; inspect the current checkout before editing.

## Acceptance checks

1. Prediction is recorded before the result is revealed.
2. At zero, intermediate, and maximum shear, the shape has the expected base, perpendicular height, and area.
3. The translated wedge fills the rectangle without gaps, overlaps, scaling, or changes of identity. Handle the degenerate zero-shear wedge explicitly.
4. Dragging is disabled during piece translation and restored at the appropriate phase.
5. Replay/reset restores a coherent initial scene and does not depend on inference.
6. Keyboard interaction, narrow layouts, and reduced motion remain usable.
7. The model receives the actual prediction and current learner state; stale responses cannot overwrite newer work.
8. The geometric demonstration works without a model connection. Any offline teaching fallback is visibly identified.
9. Run relevant state/geometry tests and visually inspect the animation in a browser. See the implementation status above for the verification results.

## Alternatives considered

| Direction | Benefit | Judgment |
| --- | --- | --- |
| Linked fraction bar, number line, and equation | Shows one value across representations | Strong future direction, but less immediate visual surprise. True shared state and cross-representation continuity require model work. |
| Existing split-array misconception demonstration | Reliable reuse of current functionality | Too close to what is already implemented to serve as the main new upgrade. Useful fallback or second example. |
| Pythagorean square-area dissection | Dramatic rearrangement proof | More geometry, sequencing, verification, and potential mismatch with the current elementary audience. |
| General 3D environment | Useful for volume, solids, and folding | Additional camera/interaction work without a clear benefit for the selected area concept. |
| Manim animation clips | Useful for authored mathematical explanations | Consider for supplementary clips; direct manipulation is central to this proposed experience. |

The initial broader recommendation was linked representations: shared mathematical state driving manipulatives, number lines, and equations. That remains a longer-term architecture direction. For the next focused hackathon build, the team selected shear and reassembly.

## Research references

- [PhET research: Implicit scaffolding in interactive simulations](https://arxiv.org/abs/1306.6544): affordances, constraints, cues, and feedback can guide productive exploration. Supports design principles, not a measured outcome for this proposed tutor.
- [PhET research-based simulation design](https://phet.colorado.edu/publications/Simulation%20Design%20AAPT%2004.pdf): additional simulation design reference identified by the research agent.
- [Polypad](https://polypad.amplify.com/p): reference for working directly with mathematical manipulatives.
- [Bret Victor: Explorable Explanations](https://worrydream.com/ExplorableExplanations/): reference for changing assumptions and observing consequences within an explanation.
- [IES elementary mathematics practice guide](https://ies.ed.gov/ncee/WWC/PracticeGuide/26): recommendations concerning representations and number lines; not evidence that this exact interface improves learning.
- [Mafs](https://mafs.dev/) and [movable points](https://mafs.dev/guides/interaction/movable-points): current interactive mathematics tooling.
- [Manim documentation](https://docs.manim.community/en/stable/): alternative for authored animation.
- [React Three Fiber](https://r3f.docs.pmnd.rs/getting-started/introduction): potential future tooling for spatial topics.

## Next-agent starting point

Read this document and applicable repository instructions, then inspect the current working tree and relevant geometry/lesson files. If asked to implement, build and visually verify the deterministic shear/cut/reassembly primitive first, then connect prediction and state to the tutor. Keep the scope to one polished demonstration and update this handoff with changed files, verification results, outstanding issues, and the exact next step.
