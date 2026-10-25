import { z } from "zod";
import { IdSchema } from "../shared/contracts";
import type { ShearLesson } from "../visual-math/shear";

const text = (max: number) => z.string().trim().min(1).max(max);
const measure = z.number().finite().min(0).max(100);
export const ShearTurnSchema = z.enum(["reveal", "explanation", "transfer"]);
export type ShearTurn = z.infer<typeof ShearTurnSchema>;
export const ShearTutorRequestSchema = z.object({
  version: z.literal(1), requestId: IdSchema, revision: z.number().int().nonnegative(),
  turn: ShearTurnSchema,
  lesson: z.object({
    prediction: z.enum(["bigger", "smaller", "same"]),
    base: measure.positive(), height: measure.positive(), shear: measure,
    largestShear: measure, adjustments: z.number().int().min(0).max(10_000),
    proofsWatched: z.number().int().min(0).max(1000), attempts: z.number().int().min(1).max(1000),
  }).strict(),
  learnerText: text(600).nullable(),
  history: z.array(z.object({ role: z.enum(["tutor", "learner"]), text: text(800) }).strict()).max(12),
}).strict();
export type ShearTutorRequest = z.infer<typeof ShearTutorRequestSchema>;
export const ShearTutorReplySchema = z.object({
  reply: text(500).describe("At most three short spoken sentences."),
  followUp: text(240).describe("Exactly one question for the learner."),
  understanding: z.enum(["not_yet", "emerging", "explained"]),
}).strict();
export interface ShearTutorMessage { role: "tutor" | "learner"; text: string; source?: "model" | "offline" }

export function shearRequest(lesson: ShearLesson, turn: ShearTurn, learnerText: string | null, history: ShearTutorMessage[]): ShearTutorRequest {
  if (!lesson.prediction) throw new Error("Record a prediction before asking the tutor.");
  const { base, height, shear } = lesson.shape;
  return ShearTutorRequestSchema.parse({
    version: 1, requestId: crypto.randomUUID(), revision: lesson.revision, turn,
    lesson: { prediction: lesson.prediction, base, height, shear, largestShear: lesson.largestShear, adjustments: lesson.adjustments, proofsWatched: lesson.proofsWatched, attempts: lesson.attempts },
    learnerText, history: history.slice(-12).map(({ role, text }) => ({ role, text: text.slice(0, 800) })),
  });
}

/** Clearly labeled scripted reply used when no model is reachable. It never grades free text. */
export function offlineShearReply(request: ShearTutorRequest): z.infer<typeof ShearTutorReplySchema> {
  const { prediction, base, height } = request.lesson, area = base * height;
  if (request.turn === "reveal") return {
    reply: prediction === "same"
      ? `You predicted it would stay the same, and it did: ${base} × ${height} = ${area} square units.`
      : `You predicted it would get ${prediction}. The slanted side did get longer, but the triangle we cut off just moved, so the area is still ${base} × ${height} = ${area}.`,
    followUp: "In your own words, why did the area stay the same?", understanding: "not_yet",
  };
  return {
    reply: "Thanks for explaining. Check your idea against the picture: the triangle was moved, not added or thrown away, and the base and height never changed.",
    followUp: `Try one more: a slanted shape with base 5 and height 3. What is its area, and why?`, understanding: "not_yet",
  };
}

export type Ask = (request: ShearTutorRequest, signal: AbortSignal) => Promise<unknown>;
/** No tutor transport connected: every turn uses the clearly labeled offline reply.
 *  (The HTTP endpoint is gone; the SpacetimeDB tutor_request/tutor_result rows replace it.) */
export const offlineShearTutor: Ask = async () => { throw new Error("No tutor connected."); };

export interface ShearTutorState { messages: ShearTutorMessage[]; pending: ShearTurn | null; error: string | null; turn: ShearTurn | null }

/** One live request at a time; a reply is accepted only if it matches the latest request and lesson revision. */
export class ShearTutorConversation {
  private state: ShearTutorState = { messages: [], pending: null, error: null, turn: null };
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private latest: string | null = null;
  constructor(private ask: Ask = offlineShearTutor) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private set(patch: Partial<ShearTutorState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(l => l()); }

  cancel = () => {
    this.controller?.abort(); this.controller = null; this.latest = null;
    if (this.state.pending) this.set({ pending: null });
  };
  reset = () => { this.cancel(); this.set({ messages: [], error: null, turn: null }); };

  async send(lesson: ShearLesson, turn: ShearTurn, learnerText: string | null, current: () => ShearLesson) {
    this.cancel();
    const history = this.state.messages;
    const request = shearRequest(lesson, turn, learnerText, history);
    const controller = new AbortController();
    this.controller = controller; this.latest = request.requestId;
    this.set({ pending: turn, error: null, turn, messages: learnerText ? [...history, { role: "learner", text: learnerText }] : history });
    let reply: z.infer<typeof ShearTutorReplySchema>, source: "model" | "offline" = "model", error: string | null = null;
    try {
      const value = z.object({ requestId: z.string(), revision: z.number() }).passthrough().parse(await this.ask(request, controller.signal));
      if (value.requestId !== request.requestId || value.revision !== request.revision) throw new Error("Stale tutor reply.");
      reply = ShearTutorReplySchema.parse({ reply: value.reply, followUp: value.followUp, understanding: value.understanding });
    } catch (cause) {
      if (controller.signal.aborted) return false;
      reply = offlineShearReply(request); source = "offline";
      error = cause instanceof Error ? cause.message : "Tutor unavailable.";
    }
    // Newer learner work (a reset, another slant, a newer question) wins over this reply.
    if (this.latest !== request.requestId || current().revision !== request.revision) return false;
    this.controller = null; this.latest = null;
    this.set({ pending: null, error, messages: [...this.state.messages, { role: "tutor", text: `${reply.reply} ${reply.followUp}`, source }] });
    return true;
  }
}
