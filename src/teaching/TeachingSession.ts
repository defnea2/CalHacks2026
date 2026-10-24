import type { CanvasState } from "../presentation/contracts";
import { VisualDirector } from "../presentation/VisualDirector";
import type { MathAction } from "../presentation/math/models";
import type { LearnerAction } from "../shared";
import { TeachingPlanner, type PlanningModel } from "./TeachingPlanner";
import type { LearnerResponse } from "./contracts";

interface SessionState {
  busy: boolean;
  error: string | null;
  beatIndex: number;
  changes: number;
}

/** Coordinates a text rehearsal. No synthetic audio clock or second teaching model. */
export class TeachingSession {
  readonly planner: TeachingPlanner;
  readonly director = new VisualDirector();
  private state: SessionState = { busy: false, error: null, beatIndex: -1, changes: 0 };
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private epoch = 0;
  private presentationStart: CanvasState | null = null;
  private presentationVersion: number | null = null;

  constructor(config: unknown, private model: PlanningModel) {
    this.planner = new TeachingPlanner(config);
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private fail(error: unknown) {
    this.publish({ error: error instanceof Error ? error.message : "Could not continue this lesson." });
  }
  cancel = () => {
    this.epoch++;
    this.abort?.abort();
    this.abort = null;
    const step = this.planner.getSnapshot().step;
    if (this.planner.getSnapshot().status === "presenting" && step) {
      const token = this.director.getSnapshot().token;
      if (token) this.director.interrupt(token);
      this.planner.interrupt(step.id);
    }
    this.presentationVersion = null;
    this.publish({ busy: false });
  };
  plan = async () => {
    if (this.state.busy) return false;
    const epoch = ++this.epoch;
    const abort = new AbortController();
    this.abort = abort;
    const context = this.director.getPlanningContext();
    this.publish({ busy: true, error: null });
    try {
      const request = this.planner.request(context.canvas);
      const output = await this.model(request, abort.signal);
      if (abort.signal.aborted || epoch !== this.epoch) return false;
      // Also catches a reset/replay to an identical canvas while the model was running.
      if (context.contextVersion !== this.director.getSnapshot().contextVersion)
        throw new Error("The picture changed while planning. Try again from the current picture.");
      this.planner.accept(request.requestId, output, this.director.getSnapshot().canvas);
      this.presentationStart = structuredClone(context.canvas);
      this.presentationVersion = context.contextVersion;
      this.publish({ beatIndex: -1, changes: 0 });
      return this.presentNext();
    } catch (error) {
      if (epoch === this.epoch && !abort.signal.aborted) this.fail(error);
      return false;
    } finally {
      if (epoch === this.epoch) {
        this.abort = null;
        this.publish({ busy: false });
      }
    }
  };
  /** Text mode reveals one whole beat; Continue reveals the next. It does not test audio timing. */
  presentNext = () => {
    const { step, status } = this.planner.getSnapshot();
    if (!step || status !== "presenting") return false;
    try {
      const index = this.state.beatIndex + 1;
      if (this.presentationVersion === null) throw new Error("No active presentation.");
      const token = this.director.prepare(step.beats[index], {
        expectedContextVersion: this.presentationVersion,
      });
      this.director.narrationStarted(token);
      this.director.narrationEnded(token);
      const visual = this.director.getSnapshot();
      if (visual.status !== "completed") throw new Error(visual.error ?? "The visual step could not finish.");
      this.presentationVersion = visual.contextVersion;
      this.publish({ beatIndex: index, error: null });
      if (index === step.beats.length - 1) this.planner.presented(step.id);
      return true;
    } catch (error) {
      this.cancel();
      this.fail(error);
      return false;
    }
  };
  /** Replays already validated commands locally; never re-queries the model or adds evidence. */
  replay = () => {
    if (this.state.busy || !this.presentationStart) return false;
    const status = this.planner.getSnapshot().status;
    if (!["presenting", "awaiting_response"].includes(status)) return false;
    this.planner.replayPresentation();
    this.director.reset(this.presentationStart);
    this.presentationVersion = this.director.getSnapshot().contextVersion;
    this.publish({ beatIndex: -1, changes: 0, error: null });
    return this.presentNext();
  };
  respond = async (response: LearnerResponse["response"]) => {
    if (this.state.busy) return false;
    try {
      const step = this.planner.getSnapshot().step;
      if (!step) throw new Error("Start a lesson first.");
      this.planner.respond({ eventId: crypto.randomUUID(), stepId: step.id, response }, this.director.getSnapshot().canvas);
      return await this.plan();
    } catch (error) {
      this.fail(error);
      return false;
    }
  };
  canInteract = () => !this.state.busy && this.planner.getSnapshot().status === "awaiting_response" && this.director.canInteract();
  interactMath = (action: MathAction) => {
    const token = this.director.getSnapshot().token;
    if (!token || !this.canInteract()) return null;
    const event = this.director.interactMath(token, action);
    if (event) this.publish({ changes: this.state.changes + 1 });
    return event;
  };
  interactActivity = (action: LearnerAction) => {
    const token = this.director.getSnapshot().token;
    if (!token || !this.canInteract()) return null;
    const event = this.director.interactActivity(token, action);
    if (event) this.publish({ changes: this.state.changes + 1 });
    return event;
  };
}
