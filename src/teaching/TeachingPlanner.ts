import { z } from "zod";
import { applyCanvasCommands } from "../presentation/canvasState";
import type { CanvasState } from "../presentation/contracts";
import {
  SessionConfigSchema,
  TeachingStepSchema,
  LearnerResponseSchema,
  type SessionConfig,
  type TeachingStep,
  type Evidence,
  type TeachingPhase,
} from "./contracts";
import { assessResponse, validateCheck } from "./checks";
import { allowedPhases } from "./policy";
import { TEACHING_INSTRUCTIONS } from "./prompts";

export interface PlannerState {
  config: SessionConfig;
  revision: number;
  status: "needs_plan" | "presenting" | "awaiting_response" | "completed";
  step: TeachingStep | null;
  history: TeachingStep[];
  evidence: Evidence[];
}
export interface PlanningRequest {
  version: 1;
  requestId: string;
  basedOnRevision: number;
  systemPrompt: string;
  responseSchema: Record<string, unknown>;
  context: {
    session: SessionConfig;
    currentStep: TeachingStep | null;
    recentSteps: TeachingStep[];
    usedExampleProblems: string[];
    evidence: Evidence[];
    allowedPhases: TeachingPhase[];
    phaseOptionsAfterAssessment: Record<
      "supported" | "misconception" | "unclear",
      TeachingPhase[]
    > | null;
    canvas: CanvasState;
  };
}
export type PlanningModel = (
  request: PlanningRequest,
  signal?: AbortSignal,
) => Promise<unknown>;
function representation(canvas: CanvasState) {
  return (
    canvas.math?.visual.kind ?? canvas.activity?.activity.kind ?? "free_form"
  );
}
function normalized(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Teaching state only. The host remains authoritative for visuals, audio and room context. */
export class TeachingPlanner {
  private state: PlannerState;
  private pending: PlanningRequest | null = null;
  private listeners = new Set<() => void>();
  constructor(config: unknown) {
    this.state = {
      config: SessionConfigSchema.parse(config),
      revision: 0,
      status: "needs_plan",
      step: null,
      history: [],
      evidence: [],
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<PlannerState>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    this.pending = null;
    this.listeners.forEach((f) => f());
  }
  private latestEvidence() {
    return this.state.evidence
      .filter((e) => e.stepId === this.state.step?.id)
      .at(-1);
  }
  request(canvas: CanvasState): PlanningRequest {
    if (["presenting", "completed"].includes(this.state.status))
      throw new Error(
        "Finish or interrupt the current presentation before planning.",
      );
    if (
      this.state.step?.check &&
      this.state.status === "awaiting_response" &&
      !this.latestEvidence()
    )
      throw new Error("Wait for the learner before generating the next step.");
    const latest = this.latestEvidence();
    const canAssess =
      latest?.source === "unassessed" &&
      latest.response.kind === "answer" &&
      this.state.step?.check?.kind === "explanation";
    const phaseOptionsAfterAssessment = canAssess
      ? {
          supported: allowedPhases(this.state.step, {
            ...latest,
            outcome: "correct",
          }),
          misconception: allowedPhases(this.state.step, {
            ...latest,
            outcome: "incorrect",
          }),
          unclear: allowedPhases(this.state.step, {
            ...latest,
            outcome: "unclear",
          }),
        }
      : null;
    const request: PlanningRequest = {
      version: 1,
      requestId: crypto.randomUUID(),
      basedOnRevision: this.state.revision,
      systemPrompt: TEACHING_INSTRUCTIONS,
      responseSchema: z.toJSONSchema(TeachingStepSchema) as Record<
        string,
        unknown
      >,
      context: {
        session: this.state.config,
        currentStep: this.state.step,
        recentSteps: this.state.history.slice(-8),
        usedExampleProblems: this.state.history.flatMap((s) =>
          s.exampleProblem ? [s.exampleProblem] : [],
        ),
        evidence: this.state.evidence.slice(-20),
        allowedPhases: allowedPhases(this.state.step, this.latestEvidence()),
        phaseOptionsAfterAssessment,
        canvas,
      },
    };
    this.pending = structuredClone(request);
    return structuredClone(request);
  }
  accept(
    requestId: string,
    input: unknown,
    actualCanvas: CanvasState,
  ): TeachingStep {
    const request = this.pending;
    if (
      !request ||
      request.requestId !== requestId ||
      request.basedOnRevision !== this.state.revision
    )
      throw new Error("Stale planning result; obtain a fresh request.");
    if (JSON.stringify(request.context.canvas) !== JSON.stringify(actualCanvas))
      throw new Error(
        "Canvas changed during planning; obtain a fresh request.",
      );
    const step = TeachingStepSchema.parse(input);
    if (this.state.history.some((s) => s.id === step.id))
      throw new Error("Teaching step IDs must be unique within a session.");
    const evidence = structuredClone(this.state.evidence);
    const latest = evidence
      .filter((e) => e.stepId === this.state.step?.id)
      .at(-1);
    if (step.assessment) {
      if (
        !latest ||
        latest.eventId !== step.assessment.evidenceId ||
        latest.source !== "unassessed" ||
        latest.response.kind !== "answer" ||
        this.state.step?.check?.kind !== "explanation"
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
    if (!allowedPhases(this.state.step, latest).includes(step.phase))
      throw new Error(
        "Phase is not supported by the current learner evidence: " + step.phase,
      );
    if (step.exampleProblem) {
      const problem = normalized(step.exampleProblem);
      if (
        this.state.config.originalQuestion &&
        problem === normalized(this.state.config.originalQuestion)
      )
        throw new Error(
          "Use a separate example, leaving the original question for the learner.",
        );
      if (
        ["solo", "transfer"].includes(step.phase) &&
        !(
          latest?.response.kind === "help" &&
          step.phase === this.state.step?.phase &&
          ["hint", "simplify"].includes(step.approach) &&
          problem === normalized(this.state.step?.exampleProblem ?? "")
        ) &&
        this.state.history.some(
          (s) => s.exampleProblem && normalized(s.exampleProblem) === problem,
        )
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
        "A representation change must change the rendered representation family.",
      );
    if (
      ["solo", "transfer"].includes(step.phase) &&
      planned.math?.visual.showEquation
    )
      throw new Error("Hide the derived answer during independent checks.");
    if (step.check?.kind === "math_value" && !planned.math?.visual.interactive)
      throw new Error("An interaction check must enable learner controls.");
    if (this.state.history.length >= 80)
      throw new Error("Session step limit reached; start a new session.");
    this.publish({
      step,
      evidence,
      history: [...this.state.history, step],
      status: "presenting",
    });
    return step;
  }
  presented(stepId: string) {
    if (this.state.step?.id !== stepId || this.state.status !== "presenting")
      throw new Error(
        "Presentation acknowledgement does not match the active step.",
      );
    this.publish({
      status:
        this.state.step.phase === "return_to_problem"
          ? "completed"
          : this.state.step.check
            ? "awaiting_response"
            : "needs_plan",
    });
  }
  interrupt(stepId: string) {
    if (this.state.step?.id !== stepId || this.state.status !== "presenting") return;
    this.publish({ status: "needs_plan" });
  }
  respond(input: unknown, canvas: CanvasState): Evidence {
    const event = LearnerResponseSchema.parse(input);
    const duplicate = this.state.evidence.find(
      (e) => e.eventId === event.eventId,
    );
    if (duplicate) {
      if (
        duplicate.stepId !== event.stepId ||
        JSON.stringify(duplicate.response) !== JSON.stringify(event.response)
      )
        throw new Error("Event ID reused with a different payload.");
      return duplicate;
    }
    const step = this.state.step;
    if (
      !step ||
      event.stepId !== step.id ||
      this.state.status !== "awaiting_response"
    )
      throw new Error(
        "Response belongs to an inactive or unfinished teaching step.",
      );
    const observation = assessResponse(step.check, event.response, canvas);
    const item: Evidence = {
      eventId: event.eventId,
      stepId: step.id,
      phase: step.phase,
      learningGoal: step.learningGoal,
      prompt: step.check?.prompt ?? "",
      response: event.response,
      assistance:
        ["solo", "transfer"].includes(step.phase) &&
        !["hint", "simplify"].includes(step.approach)
          ? "none"
          : "supported",
      ...observation,
    };
    if (this.state.evidence.length >= 160)
      throw new Error("Session evidence limit reached; start a new session.");
    this.publish({
      evidence: [...this.state.evidence, item],
      status: "needs_plan",
    });
    return item;
  }
  async generate(
    model: PlanningModel,
    canvas: CanvasState,
    getCurrentCanvas: () => CanvasState,
    signal?: AbortSignal,
  ): Promise<TeachingStep> {
    const request = this.request(canvas);
    const output = await model(request, signal);
    if (signal?.aborted) throw new Error("Planning cancelled.");
    return this.accept(request.requestId, output, getCurrentCanvas());
  }
  recap() {
    const evidence = structuredClone(this.state.evidence);
    return {
      topic: this.state.config.topic,
      originalQuestion: this.state.config.originalQuestion ?? null,
      independentChecksPassed: evidence
        .filter(
          (e) =>
            ["solo", "transfer"].includes(e.phase) &&
            e.source === "deterministic" &&
            e.outcome === "correct" &&
            e.assistance === "none",
        )
        .map((e) => ({
          evidenceId: e.eventId,
          learningGoal: e.learningGoal,
          prompt: e.prompt,
        })),
      needsMorePractice: evidence
        .filter((e) => e.outcome === "incorrect")
        .map((e) => ({
          evidenceId: e.eventId,
          learningGoal: e.learningGoal,
          tentative: e.source === "model_tentative",
        })),
      evidence,
      nextAction:
        this.state.status === "completed"
          ? "Try the original question independently."
          : "Continue from the latest observed response.",
    };
  }
}
