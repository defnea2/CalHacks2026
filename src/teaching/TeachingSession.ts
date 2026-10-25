import type { CanvasState, PlaybackToken, VisualBeat } from "../presentation/contracts";
import { VisualDirector } from "../presentation/VisualDirector";
import type { MathAction } from "../presentation/math/models";
import type { LearnerAction } from "../shared";
import { TeachingPlanner, type PlanningModel } from "./TeachingPlanner";
import type { LearnerResponse } from "./contracts";
import { TeachingStepSchema } from "./contracts";
import { blueprintOf, extendBlueprint, preflightStep, PlanningProgressSchema, type LessonBlueprint, type PlanningProgress } from "./streaming";
import { validateTeachingStep } from "./validateStep";

export interface PreparedSpeech {
  token: PlaybackToken;
  stepId: string;
  beatIndex: number;
  narration: string;
  /** The voice host must stop and clear queued audio when this signal aborts. */
  signal: AbortSignal;
}
export type VoicePlaybackEvent = { token: PlaybackToken; sequence: number } & (
  { type: "started" | "paused" | "ended" | "interrupted" } |
  { type: "progress"; elapsedMs: number }
);

interface SessionState {
  busy: boolean;
  error: string | null;
  beatIndex: number;
  changes: number;
  playbackRun: number;
  firstBeatMs: number | null;
  planCompleteMs: number | null;
}

const closed = (blueprint: LessonBlueprint): LessonBlueprint => { const { open: _open, ...rest } = blueprint; return rest; };

/** One planner/director owner for either text rehearsal or externally clocked speech. */
export class TeachingSession {
  readonly planner: TeachingPlanner;
  readonly director = new VisualDirector();
  private state: SessionState = { busy: false, error: null, beatIndex: -1, changes: 0, playbackRun: 0, firstBeatMs: null, planCompleteMs: null };
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private epoch = 0;
  private presentationStart: CanvasState | null = null;
  private presentationVersion: number | null = null;
  private blueprint: LessonBlueprint | null = null;
  private voiceBeats: VisualBeat[] = [];
  private speechAbort = new AbortController();
  private speech: PreparedSpeech | null = null;
  private playbackSequence = -1;
  private voiceFinished = 0;
  private deferredFailure: unknown = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  readonly playbackMode: "text" | "voice";

  constructor(config: unknown, private model: PlanningModel, options: { playback?: "text" | "voice" } = {}) {
    this.planner = new TeachingPlanner(config);
    this.playbackMode = options.playback ?? "text";
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
  private clearWatchdog() { if (this.watchdog) clearTimeout(this.watchdog); this.watchdog = null; }
  /** Voice host must report started/progress/ended; if it goes silent, surface a stall instead of hanging. */
  private armWatchdog(extraMs = 0) {
    this.clearWatchdog();
    const speech = this.speech;
    if (!speech) return;
    const words = speech.narration.split(/\s+/).filter(Boolean).length;
    this.watchdog = setTimeout(() => {
      if (this.speech !== speech) return;
      this.cancel();
      this.fail(new Error("Voice playback stalled. Replay the lesson or try again."));
    }, 20_000 + extraMs + (1.2 + words / 2.8) * 1000);
  }
  cancel = () => {
    this.deferredFailure = null;
    this.clearWatchdog();
    this.epoch++;
    this.abort?.abort();
    this.abort = null;
    this.speechAbort.abort();
    this.speech = null;
    if (this.playbackMode === "voice") {
      const token = this.director.getSnapshot().token;
      if (token) this.director.interrupt(token);
    }
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
    if (this.state.busy || this.planner.getSnapshot().status !== "needs_plan") return false;
    const epoch = ++this.epoch;
    const abort = new AbortController();
    this.abort = abort;
    const context = this.director.getPlanningContext();
    const started = performance.now();
    this.deferredFailure = null;
    this.blueprint = null;
    this.voiceBeats = [];
    this.voiceFinished = 0;
    this.speechAbort.abort();
    this.speechAbort = new AbortController();
    this.speech = null;
    this.presentationStart = structuredClone(context.canvas);
    this.presentationVersion = context.contextVersion;
    this.publish({ busy: true, error: null, beatIndex: -1, changes: 0, playbackRun: this.state.playbackRun + 1, firstBeatMs: null, planCompleteMs: null });
    try {
      const request = this.planner.request(context.canvas);
      const output = await this.model(request, abort.signal, event => {
        if (abort.signal.aborted || epoch !== this.epoch) return;
        if (event.type === "beat" && this.state.firstBeatMs === null) this.publish({ firstBeatMs: Math.round(performance.now() - started) });
        this.receiveProgress(event);
      });
      if (abort.signal.aborted || epoch !== this.epoch) return false;
      // Also catches a reset/replay to an identical canvas while the model was running.
      if ((this.blueprint ? this.presentationVersion : context.contextVersion) !== this.director.getSnapshot().contextVersion)
        throw new Error("The picture changed while planning. Try again from the current picture.");
      const step = TeachingStepSchema.parse(output);
      if (this.blueprint && (JSON.stringify(blueprintOf(step)) !== JSON.stringify(closed(this.blueprint)) || JSON.stringify(step.beats) !== JSON.stringify(this.voiceBeats)))
        throw new Error("Completed lesson changed an already prepared phrase or visual.");
      // All intervening director mutations are owned/version-checked by this session.
      this.planner.accept(request.requestId, step, this.blueprint ? context.canvas : this.director.getSnapshot().canvas);
      const completeMs = Math.round(performance.now() - started);
      this.publish({ firstBeatMs: this.state.firstBeatMs ?? completeMs, planCompleteMs: completeMs });
      if (this.playbackMode === "voice") {
        if (!this.blueprint) {
          this.blueprint = blueprintOf(step);
          this.voiceBeats = step.beats;
          this.prepareVoiceBeat();
        }
        if (this.voiceFinished === step.beats.length) this.planner.presented(step.id);
        return true;
      }
      if (this.blueprint && this.state.beatIndex >= 0) {
        if (this.state.beatIndex === step.beats.length - 1) this.planner.presented(step.id);
        return true;
      }
      return this.presentNext();
    } catch (error) {
      if (epoch === this.epoch && !abort.signal.aborted && this.playbackMode === "voice" && this.speech && !this.speechAbort.signal.aborted && this.director.getSnapshot().status === "speaking") {
        this.deferredFailure = error; // let the beat being spoken finish, then report
      } else if (epoch === this.epoch && !abort.signal.aborted) {
        this.speechAbort.abort(); this.speech = null; this.clearWatchdog();
        const token = this.director.getSnapshot().token;
        if (token) this.director.interrupt(token);
        const step = this.planner.getSnapshot().step;
        if (step && this.planner.getSnapshot().status === "presenting") this.planner.interrupt(step.id);
        this.fail(error);
      }
      return false;
    } finally {
      if (epoch === this.epoch) {
        abort.abort(); // Discard callbacks from a provider that emits after completion.
        this.abort = null;
        this.publish({ busy: false });
      }
    }
  };
  /** Text mode reveals one whole beat; Continue reveals the next. It does not test audio timing. */
  presentNext = () => {
    if (this.playbackMode === "voice") return false;
    const { step, status } = this.planner.getSnapshot();
    if (status !== "presenting" && !(this.state.busy && this.blueprint)) return false;
    const beats = this.blueprint ? this.voiceBeats : step?.beats;
    const lessonId = this.blueprint?.id ?? step?.id;
    if (!beats || !beats[this.state.beatIndex + 1]) return false;
    try {
      const index = this.state.beatIndex + 1;
      if (this.presentationVersion === null) throw new Error("No active presentation.");
      const token = this.director.prepare(beats[index], {
        expectedContextVersion: this.presentationVersion,
      });
      this.director.narrationStarted(token);
      this.director.narrationEnded(token);
      const visual = this.director.getSnapshot();
      if (visual.status !== "completed") throw new Error(visual.error ?? "The visual step could not finish.");
      this.presentationVersion = visual.contextVersion;
      this.publish({ beatIndex: index, error: null });
      if (step && step.id === lessonId && status === "presenting" && index === step.beats.length - 1) this.planner.presented(step.id);
      return true;
    } catch (error) {
      this.cancel();
      this.fail(error);
      return false;
    }
  };
  /** Jumps to the last released beat, applying every visual change on the way. */
  skipToEnd = () => { let moved = false; while (this.presentNext()) moved = true; return moved; };
  /** Replays already validated commands locally; never re-queries the model or adds evidence. */
  replay = () => {
    if (this.state.busy || !this.presentationStart) return false;
    const status = this.planner.getSnapshot().status;
    if (!["presenting", "awaiting_response"].includes(status)) return false;
    this.planner.replayPresentation();
    this.speechAbort.abort();
    this.speechAbort = new AbortController();
    this.speech = null;
    this.director.reset(this.presentationStart);
    this.presentationVersion = this.director.getSnapshot().contextVersion;
    this.publish({ beatIndex: -1, changes: 0, error: null, playbackRun: this.state.playbackRun + 1 });
    if (this.playbackMode === "voice") {
      const step = this.planner.getSnapshot().step!;
      this.blueprint = blueprintOf(step); this.voiceBeats = step.beats; this.voiceFinished = 0;
      this.prepareVoiceBeat();
      return true;
    }
    return this.presentNext();
  };
  private assertPresentationContext() {
    if (this.presentationVersion !== this.director.getSnapshot().contextVersion)
      throw new Error("The picture changed during speech. Replan from its current state.");
  }
  private receiveProgress(input: PlanningProgress) {
    this.assertPresentationContext();
    const event = PlanningProgressSchema.parse(input);
    if (event.type === "blueprint") {
      if (this.blueprint) throw new Error("Duplicate lesson blueprint.");
      if (!event.blueprint.open) validateTeachingStep(preflightStep(event.blueprint), this.planner.getSnapshot(), this.presentationStart!);
      this.blueprint = event.blueprint;
    } else {
      if (!this.blueprint || event.index !== this.voiceBeats.length) throw new Error("Out-of-order lesson phrase.");
      if (this.blueprint.open && event.index === this.blueprint.beats.length) this.blueprint = extendBlueprint(this.blueprint, event.beat);
      const { narration: _narration, ...visual } = event.beat;
      if (JSON.stringify(visual) !== JSON.stringify(this.blueprint.beats[event.index])) throw new Error("Phrase does not match its planned visual.");
      if (!this.blueprint.open) {
        const candidate = preflightStep(this.blueprint);
        for (const [i, beat] of [...this.voiceBeats, event.beat].entries()) candidate.beats[i] = beat;
        validateTeachingStep(candidate, this.planner.getSnapshot(), this.presentationStart!);
      } // an open blueprint is validated whole by planner.accept on complete
      this.voiceBeats.push(event.beat);
      if (this.playbackMode === "voice") {
        if (!this.speech) this.prepareVoiceBeat();
        else this.publish({});
      } else if (this.state.beatIndex < 0) {
        if (!this.presentNext()) throw new Error(this.state.error ?? "Could not present the opening visual.");
      } else this.publish({});
    }
  }
  /** Safe metadata for the UI while narration is still streaming; never exposes placeholder prose. */
  getLessonOutline = () => {
    const lesson = this.blueprint ?? this.planner.getSnapshot().step;
    return lesson ? { id: lesson.id, phase: lesson.phase, learningGoal: lesson.learningGoal, beatCount: lesson.beats.length } : null;
  };
  hasNextBeat = () => this.state.beatIndex + 1 < (this.blueprint ? this.voiceBeats : this.planner.getSnapshot().step?.beats ?? []).length;
  private prepareVoiceBeat() {
    const beat = this.voiceBeats[this.voiceFinished];
    if (!beat || !this.blueprint) return;
    this.assertPresentationContext();
    const token = this.director.prepare(beat, { expectedContextVersion: this.presentationVersion! });
    this.presentationVersion = this.director.getSnapshot().contextVersion;
    this.playbackSequence = -1;
    this.speech = { token, stepId: this.blueprint.id, beatIndex: this.voiceFinished, narration: beat.narration, signal: this.speechAbort.signal };
    this.publish({ error: null });
    this.armWatchdog();
  }
  /** Subscribe to this session; a new token means one exact phrase is ready for TTS. */
  getPreparedSpeech = (): PreparedSpeech | null => this.speech ? { ...this.speech, token: { ...this.speech.token } } : null;
  /** Optional TTS lookahead. Synthesize now; play only after getPreparedSpeech grants a token. */
  getBufferedNarrations = () => this.playbackMode !== "voice" || !this.blueprint || this.speechAbort.signal.aborted ? []
    : this.voiceBeats.slice(this.voiceFinished + 1).map((beat, i) => ({ stepId: this.blueprint!.id,
      beatIndex: this.voiceFinished + 1 + i, narration: beat.narration, signal: this.speechAbort.signal }));
  /** Events describe audible playout, not LLM completion or TTS synthesis completion. */
  playback = (event: VoicePlaybackEvent): boolean => {
    if (this.playbackMode !== "voice" || !this.speech || this.speechAbort.signal.aborted) return false;
    const { token } = this.speech;
    if (event.token.runId !== token.runId || event.token.beatId !== token.beatId || !Number.isSafeInteger(event.sequence) || event.sequence <= this.playbackSequence) return false;
    try { this.assertPresentationContext(); }
    catch (error) { this.cancel(); this.fail(error); return false; }
    const status = this.director.getSnapshot().status;
    if (event.type === "started" && !["ready", "paused"].includes(status)) return false;
    if (["ended", "paused", "progress"].includes(event.type) && !["speaking", ...(event.type === "ended" ? ["paused"] : [])].includes(status)) return false;
    if (event.type === "progress" && (!Number.isFinite(event.elapsedMs) || event.elapsedMs < this.director.getSnapshot().elapsedMs)) return false;
    try {
      this.assertPresentationContext();
      this.playbackSequence = event.sequence;
      if (event.type === "interrupted") { this.cancel(); return true; }
      if (event.type === "started") { this.director.narrationStarted(token); if (this.state.beatIndex !== this.speech.beatIndex) this.publish({ beatIndex: this.speech.beatIndex }); }
      if (event.type === "paused") this.director.narrationPaused(token);
      if (event.type === "progress") this.director.narrationProgress(token, event.elapsedMs);
      if (event.type === "ended") this.director.narrationEnded(token);
      this.presentationVersion = this.director.getSnapshot().contextVersion;
      if (this.director.getSnapshot().status === "error") throw new Error(this.director.getSnapshot().error ?? "Visual playback failed.");
      if (event.type === "ended") {
        this.voiceFinished++;
        this.speech = null;
        this.clearWatchdog();
        if (this.deferredFailure) { const failure = this.deferredFailure; this.cancel(); this.fail(failure); return true; }
        if (this.voiceFinished === this.blueprint?.beats.length && this.planner.getSnapshot().status === "presenting") this.planner.presented(this.blueprint.id);
        else this.prepareVoiceBeat();
      } else if (event.type !== "paused") this.armWatchdog();
      this.publish({});
      return true;
    } catch (error) { this.cancel(); this.fail(error); return false; }
  };
  /** Final STT text only. An interruption supplies context, not a scored answer. */
  submitTranscript = async (text: string) => {
    if (!text.trim() || text.length > 2000) return false;
    if (this.planner.getSnapshot().status === "awaiting_response" && !this.state.busy)
      return this.respond({ kind: "answer", text });
    this.cancel();
    try { this.planner.recordUtterance(text); }
    catch (error) { this.fail(error); return false; }
    return this.plan();
  };
  respond = async (response: LearnerResponse["response"]) => {
    const interrupting = response.kind === "help" && response.request !== "repeat" && this.planner.getSnapshot().status === "presenting";
    if (this.state.busy && !interrupting) return false;
    if (response.kind === "help" && response.request === "repeat") return this.replay();
    try {
      const step = this.planner.getSnapshot().step;
      if (!step) throw new Error("Start a lesson first.");
      this.planner.respond({ eventId: crypto.randomUUID(), stepId: step.id, response }, this.director.getSnapshot().canvas);
      if (interrupting) { // planner already moved to needs_plan; stop the old lesson's playback
        const token = this.director.getSnapshot().token;
        this.cancel();
        if (token) this.director.interrupt(token);
      }
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
