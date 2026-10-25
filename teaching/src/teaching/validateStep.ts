import { applyCanvasCommands } from "../presentation/canvasState";
import type { CanvasState } from "../presentation/contracts";
import { TeachingStepSchema, type SessionConfig, type TeachingStep, type Evidence } from "./contracts";
import { validateCheck } from "./checks";
import { allowedPhases } from "./policy";
import { arcStepRules } from "./arc";

interface ValidationState {
  config: SessionConfig;
  step: TeachingStep | null;
  history: TeachingStep[];
  evidence: Evidence[];
}
function representation(canvas: CanvasState) {
  return canvas.math?.visual.kind ?? canvas.activity?.activity.kind ?? "free_form";
}
function normalized(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Shared semantic preflight for the browser planner and local model bridge. */
export function validateTeachingStep(
  input: unknown,
  state: ValidationState,
  actualCanvas: CanvasState,
  usedExamples = state.history.flatMap(s => s.exampleProblem ? [s.exampleProblem] : []),
): { step: TeachingStep; evidence: Evidence[] } {
    const step = TeachingStepSchema.parse(input);
    if (state.history.some((s) => s.id === step.id))
      throw new Error("Teaching step IDs must be unique within a session.");
    const evidence = structuredClone(state.evidence);
    const latest = evidence
      .filter((e) => e.stepId === state.step?.id)
      .at(-1);
    if (step.assessment) {
      if (
        !latest ||
        latest.eventId !== step.assessment.evidenceId ||
        latest.source !== "unassessed" ||
        latest.response.kind !== "answer" ||
        state.step?.check?.kind !== "explanation"
      )
        throw new Error(
          "Assessment must cite the latest unassessed explanation, never fabricated or deterministic evidence.",
        );
      latest.source = "model_tentative";
      latest.outcome =
        step.assessment.judgement === "supported"
          ? "correct"
          : step.assessment.judgement === "misconception"
            ? "incorrect"
            : "unclear";
      latest.observation = step.assessment.observation;
    }
    if (!allowedPhases(state.step, latest, state.config).includes(step.phase))
      throw new Error(
        "Phase is not supported by the current learner evidence: " + step.phase,
      );
    const arcRules = state.config.arc ? arcStepRules(state.config.arc, step.phase) : null;
    if (arcRules) {
      // The arc's stage fixes the step's shape (e.g. the hand-back after a missed task has no check).
      if (step.beats.length < arcRules.minimum)
        throw new Error(`This lesson stage needs at least ${arcRules.minimum} connected beats.`);
      if (arcRules.check && !step.check) throw new Error("This lesson stage ends with one check for the learner.");
      if (arcRules.check && !state.step) {
        const visual = step.beats.slice(0, -1).filter(beat => beat.cues.some(cue => cue.commands.some(command => !["note", "clear"].includes(command.type))));
        if (visual.length < 2)
          throw new Error("Teach with the picture before asking: include visual commands in the explanation beats, then the check in the final beat.");
      }
    } else if (state.config.lessonStyle === "mini_lesson") {
      const opening = !state.step;
      const reteaching = latest?.outcome === "incorrect" || (
        latest?.response.kind === "help" &&
        ["explain", "simpler", "another_way"].includes(latest.response.request)
      );
      if (opening || reteaching) {
        const minimum = opening ? 4 : 3;
        if (step.beats.length < minimum || !step.check)
          throw new Error(`Teach before testing: this ${opening ? "opening lesson" : "reteaching lesson"} needs at least ${minimum} connected beats followed by one check.`);
        const visualExplanations = step.beats.slice(0, -1).filter(beat =>
          beat.cues.some(cue => cue.commands.some(command => !["note", "clear"].includes(command.type))),
        );
        if (visualExplanations.length < (opening ? 2 : 1))
          throw new Error("Teach with the picture before asking: include visual commands in the explanation beats, then the check in the final beat.");
      }
    }
    if (step.exampleProblem) {
      const problem = normalized(step.exampleProblem);
      if (
        state.config.originalQuestion &&
        problem === normalized(state.config.originalQuestion)
      )
        throw new Error(
          "Use a separate example, leaving the original question for the learner.",
        );
      if (
        ["solo", "transfer"].includes(step.phase) &&
        !(
          latest?.response.kind === "help" &&
          step.phase === state.step?.phase &&
          ["hint", "simplify"].includes(step.approach) &&
          problem === normalized(state.step?.exampleProblem ?? "")
        ) &&
        usedExamples.some((example) => normalized(example) === problem)
      )
        throw new Error("Use a fresh independent problem.");
    }
    let planned = structuredClone(actualCanvas);
    for (const beat of step.beats) {
      for (const cue of beat.cues) {
        planned = applyCanvasCommands(planned, cue.commands);
        if (["solo", "transfer"].includes(step.phase) && planned.math?.visual.showEquation)
          throw new Error("Hide the derived answer during independent checks.");
      }
    }
    validateCheck(step.check, planned);
    if (
      step.approach === "change_representation" &&
      representation(planned) === representation(actualCanvas)
    )
      throw new Error(
        "A representation change must change the rendered representation family. Either switch to a different visual kind (for example array to bars or number_line) or use approach continue or simplify with the same picture.",
      );
    if (
      ["solo", "transfer"].includes(step.phase) &&
      planned.math?.visual.showEquation
    )
      throw new Error("Hide the derived answer during independent checks.");
    if (step.check?.kind === "math_value" && !planned.math?.visual.interactive)
      throw new Error("An interaction check must enable learner controls.");
    if (state.history.length >= 80)
      throw new Error("Session step limit reached; start a new session.");
    return { step, evidence };
}
