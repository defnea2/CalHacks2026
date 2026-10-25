# Grounded voice generation

The active product is the voice tutor on `integration/abdul-voice`. This change does not migrate or extend the independent text planner.

## Contract

The model chooses a teaching intent, quantities, representation and sequence. It does not author the mathematical narration. The same evaluated scene produces the visual, equations, neutral labels and spoken claims.

```
learner speech → model proposes 1–4 teaching moments
              → compile every before/after scene
              → evaluate each teaching claim
              → accept the entire plan, or repair once
              → publish compiled board + compiled speech
              → Cartesia audio-start event advances that exact scene
```

`show_board_item` uses this input:

```json
{
  "kind": "math_canvas",
  "content": {
    "title": "Split a product",
    "moments": [
      {
        "sentenceOffset": 0,
        "visual": {"kind": "array", "rows": 3, "columns": 7},
        "teaching": {"concept": "distributivity", "action": "observe"}
      },
      {
        "sentenceOffset": 1,
        "visual": {"kind": "update", "changes": [{"type": "set_array", "splitAt": 5}]},
        "teaching": {"concept": "distributivity", "action": "change"}
      },
      {
        "sentenceOffset": 2,
        "visual": {"kind": "keep"},
        "teaching": {"concept": "distributivity", "action": "calculate"},
        "showEquation": true
      }
    ]
  }
}
```

The worker adds computed `narration` to each stored moment. Any supplied narration is replaced; it is never trusted as a factual claim. A compiled moment remains one audio cue even if its narration contains several sentences. The generated schema remains backwards compatible for reading historical records; **the generation handler requires teaching intents on every new moment**.

## Capabilities and teaching actions

| Capability | Renderer | Evaluated quantities |
| --- | --- | --- |
| Equal groups, distributivity | Array | Rows, columns, split, total, partial products |
| Fraction amount, comparison, equivalence | Equal-length bars | Shaded parts, partitions, exact cross-product comparison |
| Number order, distance | Number line | Marker coordinates, relative order, absolute distance |
| Area, area conservation | Rectangle, right triangle, parallelogram | Base, perpendicular height, shape-specific area |

`observe` describes structure; `calculate` derives its result; `compare` relates two visible objects; `change` describes an actual update; `conserve` additionally proves the measured quantity stayed equal; `question` asks about visible quantities. Optional `targets` select one or two visible bars/markers; comparisons need two. References accept IDs or unambiguous visible A/B labels. Questions are final and hide the answer equation.

Examples and transitions remain generated. These are mathematical operations, not a catalogue of fixed lessons. The compiler currently uses authored sentence patterns for their factual explanations and questions. Expressiveness is bounded by these operations.

## Enforced boundaries

- Schema validity alone is insufficient. `compileGroundedMoment` applies commands to the planned state, then `compileTeaching` evaluates claims against those values.
- Unknown capabilities and incompatible representations fail. A right-triangle area diagram cannot establish an angle-classification capability.
- Comparison targets must exist and differ. Fraction equality uses integer cross multiplication.
- An observation alone is not a completed lesson. A plan must include a calculation, comparison, transformation or learner question; repeated statements are rejected instead of padding the lesson.
- Conservation must include an actual mathematical change and preserve the relevant quantity. Changing one half into one quarter cannot be narrated as preserving the shaded amount.
- An explanation may hold the picture while referring to its most recent verified transformation. The compiler retains that actual before-state as evidence; a new picture resets it. This permits “move the pieces, then explain why” without accepting invented conservation.
- Transformations update existing objects. Cut-and-slide stages keep the same base, height and shear so pieces cannot silently resize during a proof.
- A failed final moment rejects the entire proposal before its first board item or speech is published. Numeric values are not silently clamped, repartitioned or repaired by the grounding layer.
- Canvas labels are neutral A/B identifiers; titles cannot inject independent mathematical claims. The live canvas renders diagrams, notation, measurements and usable controls, with conversation confined to its panel.
- Ordinary model text cannot reach speech in production. `ask_learner` supplies authored clarification/reasoning/handoff questions. `visual_unavailable` clears an unrelated picture and speaks a clear limitation.
- After a failed visual proposal, one repair is allowed; that round exposes only visual repair or explicit limitation. Calls to unoffered tools are rejected. Exhaustion produces the same honest limitation, never an unchecked free-text explanation.
- Preemptive generation stays behind the existing release gate. Interrupted or dropped audio cannot reveal future moments; duplicate subscription events cannot repeat them.

## Adding coverage

Add a capability to `src/presentation/math/teaching.ts` with supported renderers, a quantity evaluator, question wording and transition preconditions. Add the renderer/command semantics when necessary. Test successful examples and false claims, then extend the synthetic real-model checks. Update the voice tool description and regenerate the database schema with:

```sh
node --import ./worker/node_modules/tsx/dist/loader.mjs scripts/export-voice-canvas-schema.ts
```

Do not add a topic name to a prompt before its visual and mathematical evaluators exist.

## Limits

This prevents independently generated mathematical prose from contradicting the accepted canvas state within the implemented operations. It is not a proof of universal tutoring correctness. Topic selection, pedagogical sequencing, speech recognition and renderer implementation can still fail and need evaluation. New concepts must add coverage; unsupported requests are acknowledged instead of approximated with an unrelated diagram. Historical recordings are still readable and are not retroactively certified. Authored library tasks remain available; they are separate from generated demonstrations.

Playback alignment is at audio-cue starts, not individual words. Provider latency remains. Local learner edits are instant but are not yet sent back to the voice model as evidence; the tutor asks the learner to describe their reasoning.

## Verification

Unit tests exercise cross-family invalid claims, 144 fraction comparisons, false conservation, invalid targets, missing grounding, transactional rejection, exact stored narration, plain-text bypass prevention, interruption and preemptive output. Run `pnpm --filter e2e smoke:generation` for real-model scenarios across fractions, multiplication, distance, area preservation and unsupported topics. `smoke:pipeline` additionally runs synthetic learner audio through real STT and TTS; playback acknowledgments are simulated.

Verified locally on 2026-10-25: 509 tests passed (250 root, 112 shared, 69 worker, 38 client, 40 database), all package type checks passed, and the voice client production build passed. The existing bundle-size advisory remains. The final real-model run passed all six scenarios, including the two-turn fraction scenario and two unsupported-topic cases. Earlier runs exposed incomplete plans and ambiguous references; those now have regression checks. This small sample is not a guarantee of consistent pedagogical choices.

The final live-backend synthetic proof test produced four Cartesia audio cues for slant → cut → reassembled → question, with exact stored narration/cue agreement. First audio was available 6.401 seconds after endTurn, including 3.149 seconds for STT. These are single-run observations; microphone capture, speaker playback and VAD latency were not measured. The live client was also inspected in the browser to confirm the minimal canvas.
