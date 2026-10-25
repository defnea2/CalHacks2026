import { z } from "zod";
import { CompactLessonSchema, COMPACT_INSTRUCTIONS, compactBeat, lessonStep } from "./compactLesson";
import { validateModelStep, type ModelRequest } from "./planning";
import { blueprintOf, type PlanningProgressHandler } from "../teaching/streaming";
import type { TeachingStep } from "../teaching/contracts";
import type { CanvasState, VisualBeat } from "../presentation/contracts";

export const moment = z.object({
  visual: CompactLessonSchema.shape.visual,
  interactive: z.boolean().default(false), showEquation: z.boolean().default(false),
  narration: z.string().min(1).max(400),
}).strict();
export const meta = CompactLessonSchema.omit({ narration: true, visual: true, interactive: true, showEquation: true, sequence: true });
// meta (incl. the check, planned first) streams before any moment, so beat 0 needs only meta + one moment.
export const StreamLessonSchema = z.object({ meta, moments: z.array(moment).min(1).max(8) }).strict();
export type Meta = z.infer<typeof meta>;
export type Moment = z.infer<typeof moment>;
type Beat = ReturnType<typeof compactBeat>["beat"];

export const STREAM_INSTRUCTIONS = COMPACT_INSTRUCTIONS
  .replace("Return the requested compact lesson JSON serialized in step_json.", "Return one JSON object with meta first and moments second, matching the supplied schema.")
  + `\nIMPORTANT STREAMING FORMAT: replace the initial visual, narration and sequence described above with moments. Return EXACTLY {"meta":{"phase":"intuition","title":"...","goal":"...","approach":"introduce","reason":"...","check":{...},"assessment":null},"moments":[{"visual":{...},"narration":"..."},{"visual":{...},"narration":"..."}]}. Meta has no visual or narration. Plan the check first in meta (it concerns the FINAL picture), then the moments in order. A mini lesson MUST have at least 4 moments (usually 5–6), 120–180 spoken words total, each narration 15–35 words and at most 400 characters. Keep meta very short; omit interactive and showEquation when false; they belong only INSIDE a moment, never in meta or after the moments array. Moment one is spoken before the rest is generated, so make it a short, concrete opening. A number_line's min/max must contain every marker value you will ever use. Obey every numeric bound in the contract exactly (e.g. bars parts and shaded at most 12; show hundredths or 0.25 on a number_line instead). No question in narrations; code appends check.prompt once to the final moment. No markdown or step_json envelope.`;

// Spoken narration is declarative when a check follows: code appends the one question. A stray question can arrive
// after earlier moments were already heard, so drop it here instead of failing a lesson that cannot be regenerated.
export function declarative(m: Meta, x: Moment): Moment {
  if (!m.check || !/[?？]/u.test(x.narration)) return x;
  const kept = (x.narration.match(/[^.!?？]+[.!?？]*\s*/gu) ?? []).filter(sentence => !/[?？]/u.test(sentence)).join("").trim();
  return { ...x, narration: kept || x.narration.replace(/[?？]/gu, ".") };
}
// Models sometimes nest the moment flags inside the visual; hoist them (a strict visual would reject them).
export function hoistFlags(value: unknown): unknown {
  const v = value as { visual?: Record<string, unknown> } | null;
  if (!v || typeof v !== "object" || !v.visual || typeof v.visual !== "object") return value;
  // Code owns id, title and focus of a new picture (compact commands omit them); models copy them from the canvas.
  const { interactive, showEquation, id: _id, title: _title, focus: _focus, ...visual } = v.visual;
  return { ...(interactive === undefined ? {} : { interactive }), ...(showEquation === undefined ? {} : { showEquation }), ...v, visual };
}
// Meaning-preserving repairs of common model slips, applied before a visual is compiled.
export function sanitizeVisual(visual: Moment["visual"]): Moment["visual"] {
  const v = visual as Record<string, any>;
  if (v.kind === "number_line" && Array.isArray(v.markers)) {
    const seen = new Set<string>();
    const markers = v.markers.map((x: any) => { let id = x.id; while (seen.has(id)) id += "_"; seen.add(id); return { ...x, id }; });
    const values = markers.map((x: any) => x.value).filter((x: unknown) => typeof x === "number");
    const out: Record<string, any> = { ...v, markers };
    if (values.length) { out.min = Math.min(v.min ?? 0, Math.floor(Math.min(...values))); out.max = Math.max(v.max ?? 1, Math.ceil(Math.max(...values))); }
    return out as Moment["visual"];
  }
  if (v.kind === "bars" && Array.isArray(v.bars)) {
    const seen = new Set<string>();
    return { ...v, bars: v.bars.map((x: any) => { let id = x.id; while (seen.has(id)) id += "_"; seen.add(id); return { ...x, id, shaded: Math.min(x.shaded, x.parts) }; }) } as Moment["visual"];
  }
  return visual;
}
export const FILLERS = ["Take one more careful look at the picture.", "Notice what changed and what stayed the same."];
// The assessment is only legal for the latest unassessed explanation answer, and is required then. The model slips on both,
// after which the whole lesson would be rejected; drop an illegal one and default a missing one to the cautious "unclear".
export function fixAssessment(request: ModelRequest, m: Meta): Meta {
  const ctx = request.context;
  const latest = ctx.evidence.filter(e => e.stepId === ctx.currentStep?.id).at(-1);
  const legal = Boolean(latest && latest.source === "unassessed" && latest.response.kind === "answer" && ctx.currentStep?.check?.kind === "explanation");
  if (!legal) return m.assessment ? { ...m, assessment: null } : m;
  if (m.assessment?.evidenceId === latest!.eventId) return m;
  return { ...m, assessment: { evidenceId: latest!.eventId, judgement: m.assessment?.judgement ?? "unclear", observation: m.assessment?.observation ?? "Not enough detail to judge." } };
}
export function assemble(m: Meta, moments: Moment[]) {
  const [first, ...rest] = moments;
  return { ...m, ...first, sequence: rest };
}

/** Parses complete JSON values in the fixed meta-then-moments envelope and releases beats as they compile. */
export class LessonStreamParser {
  private buffer = "";
  private consumed = 0;
  private stage: "prefix" | "meta" | "array" | "moment" | "separator" | "end" | "dead" = "prefix";
  private meta: Meta | null = null;
  private moments: Moment[] = [];
  private beats: Beat[] = [];
  private emitted = 0;
  private planned: CanvasState;
  private length = 0;
  private source = "";
  constructor(private request: ModelRequest, private emit: PlanningProgressHandler) { this.planned = structuredClone(request.context.canvas as CanvasState); }
  /** Parsed lesson meta (null until it streamed) and the compact moments accepted so far (worker port: the module recompiles them). */
  get lessonMeta(): Meta | null { return this.meta; }
  get lessonMoments(): readonly Moment[] { return this.finalMoments ?? this.moments; }
  /** Beats already released (spoken). */
  get released(): number { return this.emitted; }
  private finalMoments: Moment[] | null = null;
  private release(index: number) {
    if (index === 0) {
      // Open blueprint: later visuals arrive with their beats; the client closes it on completion.
      const step = lessonStep(this.meta!, this.beats.slice(0, 1), this.request.requestId);
      this.emit({ type: "blueprint", blueprint: { ...blueprintOf(step as unknown as TeachingStep), open: true } });
    }
    this.emit({ type: "beat", index, beat: this.beats[index] as VisualBeat });
    this.emitted = index + 1;
  }
  push(text: string) {
    this.length += text.length;
    if (this.length > 128_000) throw new Error("Lesson output too large.");
    this.source += text;
    this.buffer += text;
    while (true) {
      const input = this.buffer.slice(this.consumed);
      if (this.stage === "prefix" || this.stage === "array") {
        const match = input.match(this.stage === "prefix" ? /^\s*(?:```(?:json)?\s*)?\{\s*"meta"\s*:\s*/ : /^\s*,\s*"moments"\s*:\s*\[\s*/);
        if (!match) break;
        this.consumed += match[0].length;
        this.stage = this.stage === "prefix" ? "meta" : "moment";
      } else if (this.stage === "meta" || this.stage === "moment") {
        try {
          const end = valueEnd(input);
          if (end === null) break;
          const value: unknown = JSON.parse(input.slice(0, end));
          this.consumed += end;
          if (this.stage === "meta") { this.meta = fixAssessment(this.request, meta.parse(value)); this.stage = "array"; continue; }
          if (this.moments.length >= 8) throw new Error("Too many lesson moments.");
          const parsed = declarative(this.meta!, moment.parse(hoistFlags(value)));
          const m = { ...parsed, visual: sanitizeVisual(parsed.visual) };
          // Compile against the canvas planned so far. Only the final moment may be interactive, and it is never released early.
          const r = compactBeat(this.meta!, m, this.moments.length, false, this.planned);
          this.moments.push(m); this.beats.push(r.beat); this.planned = r.planned;
          this.stage = "separator";
        } catch (error) {
          // Nothing spoken yet: let the caller repair. Otherwise keep what the learner heard and close the lesson there.
          if (this.stage === "meta" || this.moments.length === 0) throw error;
          this.stage = "dead";
        }
      } else if (this.stage === "separator") {
        const match = input.match(/^\s*([,\]])\s*/);
        if (!match) break;
        this.consumed += match[0].length;
        if (match[1] === ",") {
          // A following moment proves the previous one was not final, so it can be spoken now.
          this.release(this.beats.length - 1);
          this.stage = "moment";
        } else this.stage = "end";
      } else break;
    }
  }
  finish(): TeachingStep {
    // Without a grammar a model occasionally reorders keys, so streaming never started. Nothing has
    // been released in that case, so the complete reply can still be validated and played at once.
    let draft: z.infer<typeof StreamLessonSchema>;
    if (this.stage === "dead") {
      // A later moment was unusable. Keep the moments already compiled and close with a recap that carries the check.
      draft = { meta: this.meta!, moments: [...this.moments, { visual: { kind: "keep" }, interactive: true, showEquation: false, narration: "Look at the whole picture once more." }] };
    } else {
      if (this.stage !== "prefix" && this.stage !== "end") throw new Error("Incomplete lesson stream.");
      // Ignore a code fence or stray words around the object, and stray extra top-level keys (old interactive flags,
      // notes) after the moments: only meta and moments carry content, and both are validated strictly.
      const start = this.source.indexOf("{"), end = this.source.lastIndexOf("}");
      if (start < 0 || end < start) throw new Error("Incomplete lesson stream.");
      const { meta: m, moments } = JSON.parse(this.source.slice(start, end + 1)) as Record<string, unknown>;
      draft = StreamLessonSchema.parse({ meta: m, moments: Array.isArray(moments) ? moments.map(hoistFlags) : moments });
      draft.meta = this.meta ?? fixAssessment(this.request, draft.meta);
      draft.moments = draft.moments.map((x, i) => i < this.moments.length ? this.moments[i] : { ...declarative(draft.meta, x), visual: sanitizeVisual(x.visual) });
    }
    let step: TeachingStep;
    this.finalMoments = draft.moments;
    for (let pad = 0; ; pad++) {
      try { step = validateModelStep(this.request, assemble(draft.meta, draft.moments)); this.meta = draft.meta; break; }
      catch (error) {
        // Too few connected beats: pad before the not-yet-spoken final moment; spoken beats never change.
        // approach is only a label: when the picture family did not change after all, say "simplify" rather than reject spoken beats.
        if (error instanceof Error && /representation change must change/.test(error.message) && draft.meta.approach === "change_representation") { draft.meta = { ...draft.meta, approach: "simplify" }; continue; }
        if (!(error instanceof Error) || !/needs at least \d+ connected beats/.test(error.message) || pad >= FILLERS.length || draft.moments.length < 2 || draft.moments.length > 7) throw error;
        draft.moments.splice(draft.moments.length - 1, 0, { visual: { kind: "keep" }, interactive: false, showEquation: false, narration: FILLERS[pad] });
      }
    }
    // Everything already heard must be exactly what the validated lesson contains.
    for (let i = 0; i < this.emitted; i++)
      if (JSON.stringify(step.beats[i]) !== JSON.stringify(this.beats[i])) throw new Error("Streamed beat differs from the validated lesson.");
    if (this.emitted === 0) this.emit({ type: "blueprint", blueprint: blueprintOf(step) });
    for (let i = this.emitted; i < step.beats.length; i++) this.emit({ type: "beat", index: i, beat: step.beats[i] });
    return step;
  }
}

function valueEnd(input: string): number | null {
  let depth = 0, quoted = false, escaped = false;
  const first = input.search(/\S/);
  if (first < 0) return null;
  if (input[first] !== "{" && input[first] !== '"') throw new Error("Unexpected lesson stream value.");
  for (let i = first; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') { quoted = false; if (depth === 0) return i + 1; }
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { if (--depth === 0) return i + 1; }
  }
  return null;
}
