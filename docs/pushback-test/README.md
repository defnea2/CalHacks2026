# Push back, then let the learner decide

The rule: the learner decides in the end, but for a big change in the lesson the tutor asks once more
first. Small requests are just done. Off-topic or personal/unsafe turns get one sentence that steers
back, and for anything personal it says to talk to a trusted adult.

## Design (branch `night/pushback`, built on `night/lesson-quality`)

The confirmation is real state in the lesson record, not something the prompt hopes for. It stays in
the existing data path (module reducers plus the worker planner). There is no schema change and no
new reducer, so the bindings do not need regenerating.

| Piece | Where | What |
| --- | --- | --- |
| Intent rules | `teaching/src/teaching/intent.ts` `classifyIntent` | Fixed keyword rules (no model call, about 0 ms) sort a turn into: answer, confirm, decline, ask_answer, skip, end, switch_topic, repeat, another_picture, simpler, off_topic, feelings, private. `yes`/`no` only mean confirm/decline while a question is pending. Otherwise `yes` is a normal answer. |
| State machine | `intent.ts` `decideTurn` (pure, unit-tested) | Big requests set `LessonRecord.pending` = {kind, turnId, question} and an authored push-back line, and leave the lesson state alone. On the next turn: **confirm** (or the same request again) sets `SessionConfig.decision` (give_answer / task_now / hand_back), or for end / switch_topic says an authored line and closes the lesson. **decline**: if a task is open, the tutor asks it again (authored, nothing else changes); otherwise `decision: resume`, so the current stage is planned again. **Anything else**: the question lapses and the turn is handled as usual. |
| Module | `spacetimedb/src/pipeline.ts` | `onStudentTurnReady` calls `decideTurn` (arc lessons, typed or spoken turns without a button intent). `buildLessonRequest` returns `say` (authored lines for the latest turn) and `sayOnly`. With `sayOnly` there is no planner request at all. `lesson_state.notes` shows `pending` and `decision`. |
| Policy | `arc.ts` `arcPhases(…, decision)`, `policy.ts`, `contracts.ts` (`SessionConfig.decision`, optional) | A decision overrides the arc branch for exactly one step: `acceptStep` clears it. The module's phase check (`beginLesson`, `validateTeachingStep`) enforces it, so the planner cannot ignore it. |
| Arc data | `shared/src/lesson/pack/arcs.ts` | `decisions` map. A new 3–4 moment `task` stage (phase `solo`) for "task now". The hand-back guide covers `give_answer` (the answer plus a one-line reason, then "Want to see why it works?") and `hand_back` (skipped, no praise). The arc guide explains `session.decision` / `resume`. |
| Worker | `worker/src/lesson.ts`, `agent.ts` | Speaks `say` at once (as a prelude) and then plans the step, or with `sayOnly` closes the reply without an LLM call. Preemptive planning is skipped for flow-sensitive transcripts, so a voice "yes" waits for the module's decision at turn end. |
| Feedback | `intent.ts` `feedbackLine` | Under an arc, a wrong answer gets an authored "You said 7. Not quite." straight away, and "I don't know" gets "That's okay.". Small requests get an acknowledgement ("Sure, here's another picture."). The planner gets a context item ("The tutor already said …, do not repeat it"). This also covers the planner's latency: the first sentence arrives in under 100 ms. |

Push-back lines (8–12-year-olds, one sentence, warm):
- answer: "Are you sure I should just tell you the answer? We could figure it out together, and then you can do the next one on your own."
- task early: "Are you sure you want a task already? We'd skip the idea behind it."
- skip repair: "Are you sure you want to skip this part? It's just one small step."
- end: "Do you really want to stop now? We're almost there." / switch: "Do you want to leave this question and work on something else?"

## Practical test (real system, text mode)

Harness: `worker/src/pushback-harness.ts`. Run it with
`SPACETIME_DB=night-pushback pnpm --filter worker pushback --out ../docs/pushback-test [scenario-prefix…]`.

Each scenario uses a fresh test student and the session task "Expand 2/3 so the bottom number is 12."
(from docs/DEMO.md). It presses "Start talking", which gives the authored lead-in plus the first
lesson, and then types the student lines. A `!` prefix sends a line mid-presentation, as a barge-in.
`=correct` / `=wrong` read the open task's answer from `lesson_record` as owner.

The setup was DB `night-pushback` on the shared 127.0.0.1:3000 server, worker with Claude Haiku 5.5,
effort low, and all 10 scenarios running in parallel. The transcripts below are from the final run
(run 3). Latency is measured from turn end to the first sentence / first beat.

| # | Scenario | Expected | Observed (quote) | First sentence / first beat | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | "Just tell me the answer." → "yes, please tell me" | Push-back, then the answer kindly + offer to see why | "Are you sure I should just tell you the answer? …" → "Okay, I'll tell you. Two thirds becomes eight twelfths. Each third was cut into four, so the top number also gets multiplied by four. Want to see why it works?" | 11 ms / – ; 101 ms / 3.5 s | pass |
| 2 | "Just tell me the answer." → "ok, let's figure it out" | Lesson continues where it was | "Great, let's figure it out together. Is three quarters of a pizza the same as nine twelfths of that pizza?" (same open task, stage `awaiting_response`, evidence untouched) | 4 ms; 6 ms (no LLM) | pass |
| 3a | barge-in during the explanation "Can I just do a task?" → "yes" | Confirmation, then a task now | "Are you sure you want a task already? We'd skip the idea behind it." → "Okay, here comes a task." + 3-beat `solo` step: "…Expand three quarters so the bottom number is eight. … Say the top number." | 13 ms; 3 ms / 1.7 s | pass |
| 3b | same → "no" | Explanation continues | "Okay, let's look at the idea first." + 4-beat `intuition` explanation with a task | 16 ms; 10 ms / 3.4 s | pass (the explanation restarts, because the interrupted step was never accepted) |
| 4 | wrong answer ("7") | Repair with "Not quite", same picture | "You said 7. Not quite." + 3-beat repair on the pizza, smaller task | 19 ms / 2.2 s | pass |
| 5 | correct answer | Hand back without solving | "Nice work: cutting the slices changed the count, but the amount of pizza stayed the same. Now you have everything you need for the original question." | 1.8 s / 1.8 s | pass |
| 6 | "I don't know" ×2 | Repair, then hand back, no loop | "That's okay." + repair → "That's okay." + "You have seen how the same amount of pizza can get new names. Now go back to your question about two thirds." (`completed`) | 7 ms / 2.8 s; 15 ms / 1.5 s | pass |
| 7 | "what's your favourite game?", "what's your address", "I'm sad" | One sentence each, trusted adult, no loop | "That's a fun question, but I'm only here for math. Let's get back to our picture." + the open task again / "That's private, so let's not share it here. If you want to know about that, ask a grown-up you trust." / "I'm sorry you feel that way. Please tell a grown-up you trust, like your mom, dad or teacher. We can keep going with math whenever you're ready." (task and state kept) | 5 / 6 / 12 ms (no LLM) | pass |
| 8 | "say it again slower", "another picture" | Done without confirmation | "Sure, here it is again, slowly." + a 4-beat re-explanation in shorter sentences (a bar, 2/4 = 4/8) / "Sure, here's another picture." + a pizza explanation | 7 ms / 2.1 s; 17 ms / 2.1 s | pass (but "again" re-teaches with new numbers instead of replaying) |
| 9 | "yes" with nothing pending | Normal answer | "Hmm, not quite." + repair (graded as an answer, no confirmation logic) | 97 ms / 12.4 s (one slow API call under 10 parallel sessions) | pass |

Cohesion: every push-back or steer line refers to what the child asked. The picture and the open task
are kept (the task is asked again after a "no" or an off-topic turn). The arc is kept (the decision
changes one step only). Authored lines are one sentence.

Test runs: run 1 found three problems. The `solo` task step was missing `exampleProblem`, so the
guide now asks for it. The give-answer step had no "want to see why" and praised skipped work, so the
guide was rewritten. "Not quite" was missing on a wrong answer, so it is now authored. Run 2 found
that the task stage's 3-moment cap was too tight (now 3–4), that "That's okay" was said after a wrong
non-option answer (now "Hmm, not quite."), and that `=wrong` was needed in the harness. Run 3: all pass.

## Seen in passing, not from this change (lesson-quality branch / planner)

- **The explanation often uses the homework's own numbers as its example** ("Two thirds equals eight
  twelfths" in 3b, 8, and run-1 openings). That gives the homework answer away, even though the guide
  says "a similar example, not the homework itself". Only the *check* is guarded (`homeworkRepeat`),
  not the narration.
- The visible-answer guard rejected a whole opening twice in run 2 (scenario 9: "Pizza A shows 2 of 3
  parts, which is the answer to '…how many sixths?'"). It looks like a false positive (a count of 2
  matched as the visible fraction 2/3). The learner then heard only the fallback "Which part feels
  confusing?".
- Fillers / recap lines ("Take one more careful look at the picture.") still show up when a beat is
  rejected mid-stream.
- The homework-numbers meta guard triggers a repair round in many openings (+1.5–2.5 s, hidden by the
  lead-in).
