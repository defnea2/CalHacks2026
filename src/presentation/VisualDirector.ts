import { LearnerActionSchema, type LearnerAction } from "../shared";
import { applySceneCommand, commandFromAction } from "../session/sceneReducer";
import {
  MathActionSchema,
  updateMathVisual,
  type MathAction,
  type MathScene,
} from "./math/models";
import { applyCanvasCommands } from "./canvasState";
import {
  emptyCanvas,
  VisualBeatSchema,
  type CanvasResponse,
  type CanvasState,
  type PlaybackToken,
  type VisualBeat,
} from "./contracts";

export type DirectorStatus =
  | "idle"
  | "ready"
  | "speaking"
  | "paused"
  | "awaiting_answer"
  | "completed"
  | "interrupted"
  | "error";
export interface DirectorSnapshot {
  contextVersion: number;
  canvas: CanvasState;
  token: PlaybackToken | null;
  beat: VisualBeat | null;
  status: DirectorStatus;
  elapsedMs: number;
  appliedCueIds: string[];
  error: string | null;
}

/** Owns presentation only. The voice/teaching host owns narration, planning, and assessment. */
export class VisualDirector {
  private snapshot: DirectorSnapshot = {
    contextVersion: 0,
    canvas: emptyCanvas(),
    token: null,
    beat: null,
    status: "idle",
    elapsedMs: 0,
    appliedCueIds: [],
    error: null,
  };
  private listeners = new Set<() => void>();
  private beatStartCanvas: CanvasState = emptyCanvas();
  getSnapshot = () => this.snapshot;
  /** A detached planning snapshot: safe to serialize or retain during an async model call. */
  getPlanningContext = () =>
    structuredClone({
      contextVersion: this.snapshot.contextVersion,
      token: this.snapshot.token,
      status: this.snapshot.status,
      canvas: this.snapshot.canvas,
    });
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<DirectorSnapshot>) {
    const changed =
      (patch.canvas !== undefined && patch.canvas !== this.snapshot.canvas) ||
      (patch.token !== undefined && patch.token !== this.snapshot.token) ||
      (patch.status !== undefined && patch.status !== this.snapshot.status);
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      contextVersion: this.snapshot.contextVersion + (changed ? 1 : 0),
    };
    this.listeners.forEach((listener) => listener());
  }
  private matches(token: PlaybackToken) {
    return (
      token.runId === this.snapshot.token?.runId &&
      token.beatId === this.snapshot.token?.beatId
    );
  }
  /** Interaction is accepted only after the current spoken step has finished. */
  canInteract = () =>
    ["completed", "awaiting_answer"].includes(this.snapshot.status);
  interactMath(
    token: PlaybackToken,
    input: unknown,
  ): {
    type: "math_changed";
    contextVersion: number;
    token: PlaybackToken;
    action: MathAction;
    scene: MathScene;
  } | null {
    const parsed = MathActionSchema.safeParse(input);
    const scene = this.snapshot.canvas.math;
    if (
      !this.matches(token) ||
      !this.canInteract() ||
      !parsed.success ||
      !scene?.visual.interactive
    )
      return null;
    const action = parsed.data;
    if (
      action.visualId !== scene.visual.id ||
      action.revision !== scene.revision ||
      scene.appliedEventIds.includes(action.eventId)
    )
      return null;
    // Learners can manipulate quantities, but cannot grant themselves controls or reveal equations.
    if (!["set_array", "set_bar", "move_marker", "set_geometry"].includes(action.change.type))
      return null;
    try {
      const next = {
        visual: updateMathVisual(scene.visual, action.change),
        revision: scene.revision + 1,
        appliedEventIds: [...scene.appliedEventIds, action.eventId].slice(
          -1000,
        ),
      };
      this.publish({ canvas: { ...this.snapshot.canvas, math: next } });
      return {
        type: "math_changed",
        contextVersion: this.snapshot.contextVersion,
        token,
        action,
        scene: next,
      };
    } catch {
      return null;
    }
  }
  interactActivity(
    token: PlaybackToken,
    input: unknown,
  ): {
    type: "activity_changed";
    contextVersion: number;
    token: PlaybackToken;
    action: LearnerAction;
    scene: NonNullable<CanvasState["activity"]>;
  } | null {
    const parsed = LearnerActionSchema.safeParse(input);
    const scene = this.snapshot.canvas.activity;
    if (
      !this.matches(token) ||
      !this.canInteract() ||
      !parsed.success ||
      !scene
    )
      return null;
    const result = applySceneCommand(scene, commandFromAction(parsed.data));
    if (!result.ok || result.status === "already_applied") return null;
    this.publish({
      canvas: { ...this.snapshot.canvas, activity: result.scene },
    });
    return {
      type: "activity_changed",
      contextVersion: this.snapshot.contextVersion,
      token,
      action: parsed.data,
      scene: result.scene,
    };
  }
  prepare(
    input: unknown,
    options: { expectedContextVersion?: number } = {},
  ): PlaybackToken {
    if (
      options.expectedContextVersion !== undefined &&
      options.expectedContextVersion !== this.snapshot.contextVersion
    )
      throw new Error(
        "Stale teaching plan: the learner or explanation changed. Read the current context and replan.",
      );
    const beat = VisualBeatSchema.parse(input);
    // Preflight every cue against a clone before making any new narration active.
    let planned = this.snapshot.canvas;
    for (const cue of beat.cues)
      planned = applyCanvasCommands(planned, cue.commands);
    if (
      beat.question?.nodeIds.some(
        (id) => !planned.nodes.some((node) => node.id === id),
      )
    )
      throw new Error(
        "Question refers to an object absent from the completed scene.",
      );
    this.beatStartCanvas = structuredClone(this.snapshot.canvas);
    const token = { runId: crypto.randomUUID(), beatId: beat.id };
    this.publish({
      token,
      beat,
      status: "ready",
      elapsedMs: 0,
      appliedCueIds: [],
      error: null,
    });
    return token;
  }
  replay(): PlaybackToken | null {
    if (!this.snapshot.beat) return null;
    const token = { runId: crypto.randomUUID(), beatId: this.snapshot.beat.id };
    this.publish({
      token,
      canvas: structuredClone(this.beatStartCanvas),
      status: "ready",
      elapsedMs: 0,
      appliedCueIds: [],
      error: null,
    });
    return token;
  }
  private advance(elapsedMs: number, finish = false) {
    const { beat, canvas, appliedCueIds } = this.snapshot;
    if (!beat) return;
    try {
      let next = canvas;
      const applied = [...appliedCueIds];
      for (const cue of beat.cues) {
        if ((finish || cue.atMs <= elapsedMs) && !applied.includes(cue.id)) {
          next = applyCanvasCommands(next, cue.commands);
          applied.push(cue.id);
        }
      }
      this.publish({ canvas: next, appliedCueIds: applied, elapsedMs });
    } catch (error) {
      this.publish({
        status: "error",
        error: error instanceof Error ? error.message : "Invalid visual cue.",
      });
    }
  }
  narrationStarted(token: PlaybackToken) {
    if (
      !this.matches(token) ||
      !["ready", "paused"].includes(this.snapshot.status)
    )
      return;
    this.publish({ status: "speaking" });
    this.advance(this.snapshot.elapsedMs);
  }
  narrationProgress(token: PlaybackToken, elapsedMs: number) {
    if (
      !this.matches(token) ||
      this.snapshot.status !== "speaking" ||
      !Number.isFinite(elapsedMs) ||
      elapsedMs < this.snapshot.elapsedMs
    )
      return;
    this.advance(elapsedMs);
  }
  narrationPaused(token: PlaybackToken) {
    if (this.matches(token) && this.snapshot.status === "speaking")
      this.publish({ status: "paused" });
  }
  narrationEnded(token: PlaybackToken) {
    if (
      !this.matches(token) ||
      !["speaking", "paused"].includes(this.snapshot.status)
    )
      return;
    this.advance(this.snapshot.elapsedMs, true);
    if (this.snapshot.status !== "error")
      this.publish({
        status: this.snapshot.beat?.question ? "awaiting_answer" : "completed",
      });
  }
  interrupt(token: PlaybackToken) {
    if (
      this.matches(token) &&
      !["idle", "interrupted"].includes(this.snapshot.status)
    )
      this.publish({ status: "interrupted" });
  }
  respond(nodeId: string): CanvasResponse | null {
    if (
      this.snapshot.status !== "awaiting_answer" ||
      !this.snapshot.token ||
      !this.snapshot.beat?.question?.nodeIds.includes(nodeId)
    )
      return null;
    const response: CanvasResponse = {
      ...this.snapshot.token,
      type: "choose_node",
      nodeId,
    };
    this.publish({ status: "completed" });
    return response;
  }
  /** Restore a previously validated local checkpoint; invalidate all old playback tokens. */
  reset(canvas: CanvasState = emptyCanvas()) {
    this.publish({
      canvas: structuredClone(canvas),
      token: null,
      beat: null,
      status: "idle",
      elapsedMs: 0,
      appliedCueIds: [],
      error: null,
    });
  }
}
