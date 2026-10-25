// Deterministic quality guards for a lesson's check (the learner's task), found in demo rehearsals:
//   homeworkRepeat   the task uses every number of the homework (a paraphrase of it)
//   choiceProblem    a choice task whose options do not contain exactly one correct answer
//   visibleAnswer    the task's answer is already drawn on the canvas (e.g. "how many sixths?" with 3/6 shown)
// plus the small reader for numbers and fractions in plain and spoken form they share with grading
// (spokenValue: "nine twelfths", "9/12", "it's nine").
import type { CanvasState } from "../presentation/contracts";
import type { TeachingCheck } from "./contracts";
import { numericValue } from "./checks";
import { numberItems, numbersIn, ordinal, spokenValue, TENS, UNITS, type NumberItem } from "./numbers";

const key = (n: number) => n.toFixed(9);
const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const valueOf = (x: Extract<NumberItem, { kind: "num" | "frac" }>) => (x.kind === "num" ? x.value : x.num / x.den);
const show = (x: Extract<NumberItem, { kind: "num" | "frac" }>) => (x.kind === "num" ? String(x.value) : `${x.num}/${x.den}`);

/** The text of a check's expected answer (choice: the correct label; number: the rule's value). */
function answerText(check: TeachingCheck): string {
  if (check.kind === "choice") return check.options.find(o => o.id === check.correctOptionId)?.label ?? "";
  if (check.kind === "number") return String(numericValue(check.rule));
  return "";
}

/**
 * The check uses every number of the homework (with multiplicity), e.g. homework "Expand 2/3 so the
 * bottom number is 12" and the check "Which fraction is the same amount as two thirds?" with the
 * answer eight twelfths. A paraphrase passes a substring test; the numbers do not change.
 */
export function homeworkRepeat(check: TeachingCheck | null | undefined, originalQuestion: string | undefined): string | null {
  if (!check || !originalQuestion) return null;
  const homework = numbersIn(originalQuestion);
  if (homework.length < 2) return null;
  // Every fraction the check names (two or more) is a fraction of the homework: "What is one quarter
  // plus two quarters?" for "Why is 1/4 + 2/4 not 3/8?".
  const fractions = (t: string) => numberItems(t).flatMap(x => (x.kind === "frac" ? [`${x.num}/${x.den}`] : []));
  const own = fractions(originalQuestion);
  const asked = fractions(check.prompt);
  if (asked.length >= 2 && asked.every(f => own.includes(f)))
    return `The check uses the same fractions as the learner's homework ("${originalQuestion}"), so it is the homework in other words. Ask a similar task with different numbers; the homework is handed back at the end.`;
  const counts = new Map<string, number>();
  for (const n of numbersIn(`${check.prompt} ${answerText(check)}`)) counts.set(key(n), (counts.get(key(n)) ?? 0) + 1);
  for (const n of homework) {
    const c = counts.get(key(n)) ?? 0;
    if (!c) return null;
    counts.set(key(n), c - 1);
  }
  return `The check uses the same numbers as the learner's homework ("${originalQuestion}"), so it is the homework in other words. Ask a similar task with different numbers; the homework is handed back at the end.`;
}

const NUMBER_GLUE = new Set(["a", "an", "over", "out", "of", "point", "and"]);
/** A label that is only a number or fraction ("3 sixths", "eight twelfths", "0.25", "2/3"). */
function pureNumber(label: string): boolean {
  const words = label.toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.every(w => NUMBER_GLUE.has(w) || UNITS.includes(w) || TENS.includes(w) || ordinal(w) !== undefined);
}

/** Option values of a choice check; a bare number takes the denominator a prompt names alone ("how many sixths?"). */
function optionValues(check: Extract<TeachingCheck, { kind: "choice" }>) {
  const bareDens = numberItems(check.prompt).filter(x => x.kind === "den").map(x => (x as { den: number }).den);
  const values = check.options.map(o => {
    const v = spokenValue(o.label);
    // The label must be the number itself ("3 sixths", "0.25"), not a sentence that mentions one.
    if (!v || !pureNumber(o.label)) return null;
    if (v.kind === "num" && Number.isInteger(v.value) && bareDens.length === 1) return { kind: "frac" as const, num: v.value, den: bareDens[0]! };
    return v;
  });
  return values.every(v => v) ? (values as Extract<NumberItem, { kind: "num" | "frac" }>[]) : null;
}

/**
 * A choice check must contain exactly one option that satisfies its rule, and it must be the
 * correct option. Only checked where the rule is clear: "which is the same as <one fraction>" or
 * "which is bigger/smaller" with numeric options. Anything else is left to the model.
 */
export function choiceProblem(check: TeachingCheck | null | undefined): string | null {
  if (check?.kind !== "choice") return null;
  const values = optionValues(check);
  if (!values) return null;
  const prompt = check.prompt.toLowerCase();
  const labels = check.options.map(o => `"${o.label}"`).join(", ");
  const correctIdx = check.options.findIndex(o => o.id === check.correctOptionId);
  let matching: number[] = [];
  let rule = "";
  if (/\b(same amount|same as|equal|equals|equivalent|as much as)\b/.test(prompt)) {
    const targets = numberItems(check.prompt).filter(x => x.kind === "frac") as Extract<NumberItem, { kind: "frac" }>[];
    const distinct = [...new Set(targets.map(t => key(t.num / t.den)))];
    if (distinct.length !== 1) return null;
    const target = targets[0]!;
    matching = values.flatMap((v, i) => (same(valueOf(v), target.num / target.den) ? [i] : []));
    rule = `equals ${show(target)}`;
  } else if (/\b(which|what)\b/.test(prompt) && !/\bhow (many|much)\b/.test(prompt)) {
    const bigger = /\b(bigger|biggest|larger|largest|greater|greatest|more)\b/.test(prompt);
    const smaller = /\b(smaller|smallest|less|least|fewer)\b/.test(prompt);
    if (bigger === smaller) return null;
    const best = (bigger ? Math.max : Math.min)(...values.map(valueOf));
    matching = values.flatMap((v, i) => (same(valueOf(v), best) ? [i] : []));
    rule = bigger ? "is the biggest" : "is the smallest";
  } else return null;
  if (matching.length === 1 && matching[0] === correctIdx) return null;
  if (matching.length === 0) return `The choice task has no correct option: none of ${labels} ${rule}. Exactly one option must be correct.`;
  if (matching.length > 1) return `The choice task has ${matching.length} correct options (${matching.map(i => `"${check.options[i]!.label}"`).join(", ")} ${rule}). Exactly one option must be correct.`;
  return `correctOptionId names "${check.options[correctIdx]?.label ?? check.correctOptionId}", but the option that ${rule} is "${check.options[matching[0]!]!.label}".`;
}

/**
 * The check's answer is already drawn: a fraction bar shows exactly the expected fraction (choice
 * label "3 sixths"; number answer 3 to "how many sixths?" or to "... bottom number is 12"). An
 * equivalent fraction on the board is the teaching point and stays allowed.
 */
export function visibleAnswer(check: TeachingCheck | null | undefined, canvas: CanvasState): string | null {
  const visual = canvas.math?.visual;
  if (!check || visual?.kind !== "bars" || !(check.kind === "choice" || check.kind === "number")) return null;
  let answer: { num: number; den?: number } | null = null;
  if (check.kind === "choice") {
    const label = check.options.find(o => o.id === check.correctOptionId)?.label ?? "";
    const v = spokenValue(label);
    if (v?.kind === "frac") answer = { num: v.num, den: v.den };
    else if (v && Number.isInteger(v.value)) answer = { num: v.value };
  } else {
    const n = numericValue(check.rule);
    if (Number.isInteger(n)) answer = { num: n };
  }
  if (!answer) return null;
  const dens = answer.den ? [answer.den] : numbersIn(check.prompt).filter(n => Number.isInteger(n) && n > 0);
  const bar = visual.bars.find(b => b.shaded === answer!.num && dens.includes(b.parts));
  if (!bar) return null;
  return `The task's answer is already on the picture: "${bar.label}" shows ${bar.shaded} of ${bar.parts} parts, which is the answer to "${check.prompt}". Ask a task whose answer is not drawn (different numbers than every bar shown), or draw a different picture.`;
}

/** Voice tutor: the check is spoken and answered by voice (or typed), never "type/click/tap". */
export function speakablePrompt(prompt: string): string {
  return prompt
    .replace(/\btype( in)?\b(?! of)/gi, m => (m[0] === m[0]!.toUpperCase() ? "Say" : "say"))
    .replace(/\b(click|tap)( on)?\b/gi, m => (m[0] === m[0]!.toUpperCase() ? "Choose" : "choose"));
}
