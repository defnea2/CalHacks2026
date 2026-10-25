// "Push back, then let the learner decide": a learner utterance that asks for a significant change
// of the lesson (the answer to the homework, a task before the idea, skipping the repair, ending,
// another topic) is not done at once: the tutor asks once ("Are you sure...?"), and the NEXT turn
// decides. Confirmed (or the same request again) -> the change happens; declined -> the lesson goes
// on where it was. Small requests (again, slower, another picture) are just done. Off-topic and
// personal/unsafe turns get one authored sentence that steers back (a trusted adult for anything
// personal), never a confirmation loop.
//
// Deterministic keyword rules (no model call, no latency); the module owns the state
// (LessonRecord.pending) and the decision travels to the planner in SessionConfig.decision.
import type { LessonRecord } from "./lessonFlow";
import type { LearnerDecision } from "./contracts";

export type LearnerIntent =
  | "answer" // anything else: an answer to the task or plain context
  | "confirm"
  | "decline"
  | "ask_answer"
  | "skip" // skip the current part (explain -> task now, repair -> hand back)
  | "end"
  | "switch_topic"
  | "repeat"
  | "another_picture"
  | "simpler"
  | "off_topic"
  | "feelings"
  | "private";

/** The significant requests that need a confirmation. */
export type PendingKind = "ask_answer" | "skip_to_task" | "skip_repair" | "end" | "switch_topic";
export interface PendingConfirmation {
  kind: PendingKind;
  /** The learner turn that asked (its id), and the tutor's question. */
  turnId: string;
  question: string;
}
/** Authored tutor lines for one learner turn; sayOnly = no lesson step is planned after them. */
export interface AuthoredReply {
  turnId: string;
  lines: string[];
  sayOnly: boolean;
}

const norm = (s: string) =>
  ` ${s.toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;
const has = (s: string, re: RegExp) => re.test(s);

const DECLINE = /^ (no|nope|nah|not really|not yet|never ?mind)\b| (let's|lets|let us|we can|i'll|i will|i want to|i can) (figure|try|work|do it|find|think|learn|keep|see|look)| figure (it|this) out | (keep|go on|continue) (going|explaining|with)| explain (it )?first | i'll try | the idea first | show me why /;
const CONFIRM = /^ (yes|yeah|yep|yup|ya|sure|ok|okay|please|i'm sure|i am sure|i really|really|definitely|of course|do it|go ahead|just tell me|just give me|tell me)\b| i'm sure | i am sure | yes /;
const ASK_ANSWER = / (tell|give|say|show) me the (answer|solution|result)| what's the answer | what is the answer | just (tell|give) me (it|the answer) | just tell me | (do|solve) (it|this|my homework|the homework) for me | can you (just )?(solve|do) it | (the )?answer please /;
const SKIP = / skip | (give|get) me (a |the |another )?(task|question|problem|exercise)| (can|could) i (just )?(do|have|get|try) (a |the )?(task|question|problem|exercise)| let me (do|try) (a |the )?(task|question|problem|exercise)| i (already )?know (this|it|that)( already)? | move on | (next|go to the) (part|task|question) /;
const END = / (stop|quit|i'm done|i am done|i want to go|i have to go|bye|goodbye|end the (lesson|session)|no more math|i'm tired|i am tired)\b/;
const SWITCH = / (different|another|other|new) (topic|subject|homework)| something else | change the (topic|subject)/;
const REPEAT = / (say|tell|explain|read) (it|that|this) (again|slower)| again | repeat | slower | slow down | didn't (hear|catch|get) (that|it|you)| what did you say | one more time /;
const PICTURE = / (another|different|other|new) (picture|way|drawing|example|image)| draw it (again|differently)| show (me )?another /;
const SIMPLER = / simpler | easier | too hard | too difficult | smaller step /;
const FEELINGS = / (i'm|i am|i feel|im) (so |really |very )?(sad|scared|afraid|lonely|upset|unhappy|worried|angry|crying)| nobody likes me | (bully|bullied|bullies|bullying) | hurt me | hits me | hate myself | (kill|die|suicide) /;
const PRIVATE = / (your|my) (home )?(address|phone|phone number|password|location)| where (do )?(you|i) live | where are you | meet (me|you) | send (me )?a (photo|picture) of you /;
const OFF_TOPIC = / (your )?favou?rite | video ?games? | minecraft | fortnite | roblox | pokemon | youtube | movies? | tv show | tell me a joke | are you (a robot|real|human|an ai|alive) | how old are you | what's your name | what is your name | who made you | do you have (a )?(pet|dog|cat|family) /;

/**
 * The learner's intent. `pending`: a confirmation is open (only then do yes/no mean confirm/decline;
 * otherwise "yes" is an ordinary answer). Safety first, then confirmations, then requests.
 */
export function classifyIntent(text: string, pending = false): LearnerIntent {
  const s = norm(text);
  if (s.trim() === "") return "answer";
  if (has(s, FEELINGS)) return "feelings";
  if (has(s, PRIVATE)) return "private";
  if (pending) {
    if (has(s, DECLINE)) return "decline";
    if (has(s, CONFIRM) && !has(s, / not /)) return "confirm";
  }
  if (has(s, ASK_ANSWER)) return "ask_answer";
  if (has(s, SWITCH)) return "switch_topic";
  if (has(s, PICTURE)) return "another_picture";
  if (has(s, SKIP)) return "skip";
  if (has(s, END)) return "end";
  if (has(s, SIMPLER)) return "simpler";
  if (has(s, REPEAT)) return "repeat";
  if (has(s, OFF_TOPIC)) return "off_topic";
  return "answer";
}

/** True if the turn may change the lesson flow (the worker does not plan it preemptively). */
export const flowSensitive = (text: string) => classifyIntent(text, true) !== "answer";

export const PUSHBACK: Record<PendingKind, string> = {
  ask_answer: "Are you sure I should just tell you the answer? We could figure it out together, and then you can do the next one on your own.",
  skip_to_task: "Are you sure you want a task already? We'd skip the idea behind it.",
  skip_repair: "Are you sure you want to skip this part? It's just one small step.",
  end: "Do you really want to stop now? We're almost there.",
  switch_topic: "Do you want to leave this question and work on something else?",
};
const CONFIRMED: Record<PendingKind, { lines: string[]; decision?: LearnerDecision; sayOnly?: boolean }> = {
  ask_answer: { lines: ["Okay, I'll tell you."], decision: "give_answer" },
  skip_to_task: { lines: ["Okay, here comes a task."], decision: "task_now" },
  skip_repair: { lines: ["Okay, let's skip it."], decision: "hand_back" },
  end: { lines: ["Okay, we'll stop here. You worked really well today. Bye!"], sayOnly: true },
  switch_topic: { lines: ["Okay! Tell me your new question, and we'll start fresh."], sayOnly: true },
};
const DECLINED: Record<PendingKind, string> = {
  ask_answer: "Great, let's figure it out together.",
  skip_to_task: "Okay, let's look at the idea first.",
  skip_repair: "Great, let's do this small step.",
  end: "Great, let's keep going.",
  switch_topic: "Okay, let's stay with this one.",
};
const STEER = {
  off_topic: "That's a fun question, but I'm only here for math. Let's get back to our picture.",
  feelings: "I'm sorry you feel that way. Please tell a grown-up you trust, like your mom, dad or teacher. We can keep going with math whenever you're ready.",
  private: "That's private, so let's not share it here. If you want to know about that, ask a grown-up you trust.",
};

/** What the module does with a learner turn before the usual answer / help / context handling. */
export interface TurnDecision {
  record: LessonRecord;
  /** Handled here (pending / decision / authored reply set); otherwise the caller goes on as usual
   *  with `record` (pending cleared) and, for small requests, `help`. */
  handled: boolean;
  help?: "repeat" | "another_way" | "simpler";
  /** Authored first line for the help step (spoken while the step is planned). */
  ack?: string[];
}

const ACK = { repeat: "Sure, here it is again, slowly.", another_picture: "Sure, here's another picture.", simpler: "Okay, let's take a smaller step." };

/**
 * Authored first line after an assessed answer under an arc (spoken at once, while the next step
 * is planned): a wrong answer is named kindly ("You said ninety nine. Not quite."), "I don't know"
 * gets "That's okay.", anything else unclear "Hmm, not quite.". The planner is told it was said, so it does not repeat it.
 */
export function feedbackLine(outcome: string, text: string): string | null {
  const said = text.trim().replace(/[.!?]+$/, "");
  if (outcome === "incorrect") return said && said.split(/\s+/).length <= 6 ? `You said ${said}. Not quite.` : "Not quite.";
  if (outcome === "unclear") return /\b(don'?t know|not sure|no idea|dunno|don'?t get)\b/i.test(said) ? "That's okay." : "Hmm, not quite.";
  return null;
}

const bump = (r: LessonRecord, patch: Partial<LessonRecord>): LessonRecord => ({ ...r, ...patch, revision: r.revision + 1 });
const withDecision = (r: LessonRecord, decision: LearnerDecision | undefined): LessonRecord => ({ ...r, config: { ...r.config, decision } });
const note = (r: LessonRecord, id: string, text: string): LessonRecord => ({
  ...r,
  config: { ...r.config, context: [...r.config.context.slice(-11), { id, text: text.slice(0, 2000), source: "learner choice" }] },
});

/** The stage the lesson is in, for the meaning of "skip". */
function inRepair(r: LessonRecord): boolean {
  return r.step?.phase === "repair";
}
function checkOpen(r: LessonRecord): string | null {
  return r.status === "awaiting_response" && r.step?.check ? r.step.check.prompt : null;
}

/**
 * The push-back state machine. Pure: the module calls it at every ready student turn (turnId =
 * the evidence/event id of the turn) and stores the result. Not used without an arc.
 */
export function decideTurn(record: LessonRecord, text: string, turnId: string): TurnDecision {
  const pending = record.pending ?? null;
  const intent = classifyIntent(text, !!pending);
  const base: LessonRecord = { ...record, pending: undefined, reply: undefined };
  const say = (r: LessonRecord, lines: string[], sayOnly: boolean): TurnDecision => ({ record: bump(r, { reply: { turnId, lines, sayOnly } }), handled: true });
  const open = checkOpen(record);
  const lessonOver = record.status === "completed";

  // Safety and off-topic: one authored line, the lesson state stays as it was.
  if (intent === "feelings" || intent === "private") return say(base, [STEER[intent]], true);
  if (intent === "off_topic") return open ? say(base, [STEER.off_topic, open], true) : say(lessonOver ? base : withDecision(base, "resume"), [STEER.off_topic], lessonOver);
  if (intent === "end" && lessonOver) return say(base, ["Bye! You worked really well today."], true);

  if (pending) {
    // The same request again counts as insisting.
    const again = intent !== "answer" && pendingKind(record, intent) === pending.kind;
    if (intent === "confirm" || again) {
      const c = CONFIRMED[pending.kind];
      let r = note(base, turnId, `The tutor asked: "${pending.question}" The learner confirmed: "${text}".`);
      if (pending.kind === "end") r = { ...r, status: "completed" };
      if (pending.kind === "switch_topic") r = { ...r, status: "completed" };
      if (c.decision) r = { ...withDecision(r, c.decision), status: r.status === "presenting" || r.status === "awaiting_response" ? "needs_plan" : r.status };
      return say(r, c.lines, !!c.sayOnly);
    }
    if (intent === "decline") {
      const r = note(base, turnId, `The tutor asked: "${pending.question}" The learner said no: "${text}". Keep going where the lesson was.`);
      if (open) return say(r, [DECLINED[pending.kind], open], true);
      return say(withDecision(r, "resume"), [DECLINED[pending.kind]], false);
    }
    // Something else: the question lapses; the turn is handled as usual below.
  }

  const kind = pendingKind(record, intent);
  if (kind) {
    const question = PUSHBACK[kind];
    return say(bump(base, { pending: { kind, turnId, question } }), [question], true);
  }
  // "Give me a task" while the task is already open: just ask it again.
  if (intent === "skip" && open) return say(base, ["Here is your task.", open], true);
  if (intent === "repeat" || intent === "another_picture" || intent === "simpler")
    return { record: base, handled: false, help: intent === "another_picture" ? "another_way" : intent, ack: [ACK[intent]] };
  return { record: base, handled: false };
}

/** The confirmation a request needs in the current lesson state, or null (nothing to confirm). */
function pendingKind(record: LessonRecord, intent: LearnerIntent): PendingKind | null {
  const over = record.status === "completed";
  switch (intent) {
    case "ask_answer":
      return "ask_answer";
    case "skip":
      if (over) return null;
      if (inRepair(record)) return "skip_repair";
      return checkOpen(record) ? null : "skip_to_task";
    case "end":
      return "end";
    case "switch_topic":
      return "switch_topic";
    default:
      return null;
  }
}
