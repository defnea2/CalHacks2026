// A realistic streamed mini lesson (meta first, then moments), shared by the teaching, module and
// worker tests. Same content as the team's streamingLesson.test.ts mini-lesson case.
export const miniMeta = {
  phase: "intuition", title: "Equal shares", goal: "See equivalent fractions", approach: "introduce", reason: "Teach before checking", assessment: null,
  check: { kind: "explanation", prompt: "Why is the shaded amount still the same?", rubric: ["The whole and shaded proportion stay equal"] },
} as const;

const bar = (parts: number, shaded: number, extra = {}) => ({ visual: { kind: "update", changes: [{ type: "set_bar", barId: "whole", parts, shaded }] }, ...extra });
const narrations = [
  "Start with one whole split into two equal pieces. One of these pieces is shaded, so one half is shaded.",
  "Split each piece into two smaller pieces. There are now four pieces, and two are shaded. The shaded length has not grown.",
  "This time each half contains three little pieces. Three out of six is still one half because we only changed the divisions.",
  "Eight equal pieces work too. Four of them cover exactly the same shaded length. More pieces means each piece is smaller.",
  "Return to quarters. The bottom number counts equal pieces in the whole; the top number counts the pieces we shaded.",
  "These fractions use different numbers to describe the same amount. You can change the picture now and explain what stays the same.",
];
export const miniMoments: Array<{ visual: Record<string, unknown>; narration: string; interactive?: boolean; showEquation?: boolean }> = [
  { visual: { kind: "bars", bars: [{ id: "whole", label: "One whole", parts: 2, shaded: 1 }] } }, bar(4, 2), bar(6, 3), bar(8, 4, { showEquation: true }), bar(4, 2, { showEquation: true }),
  { visual: { kind: "keep" }, interactive: true },
].map((m, i) => ({ ...m, narration: narrations[i]! }));

/** The exact JSON text a model streams for the mini lesson. */
export const miniLessonText = () => JSON.stringify({ meta: miniMeta, moments: miniMoments });
export const miniSession = { sessionId: "s1", topic: "Equivalent fractions", lessonStyle: "mini_lesson", age: 9 } as const;

// The two-minute demo arc (lesson pack `demo2min`): explain (5 moments, formalization = moment 3,
// one choice task), repair (3 moments, one number task), hand back (1 moment, no check).
const set = (parts: number, shaded: number) => ({ kind: "update", changes: [{ type: "set_bar", barId: "pizza", parts, shaded }] });
export const demoMeta = {
  phase: "intuition", title: "Same pizza, more slices", goal: "Expanding keeps the amount", approach: "introduce", reason: "Own the first explanation", assessment: null,
  check: { kind: "choice", prompt: "Which fraction is the same as one half?", options: [{ id: "a", label: "2/4" }, { id: "b", label: "2/3" }], correctOptionId: "a" },
} as const;
export const demoMoments: Array<{ visual: Record<string, unknown>; narration: string; interactive?: boolean; showEquation?: boolean }> = [
  { visual: { kind: "bars", bars: [{ id: "pizza", label: "Pizza", parts: 3, shaded: 2 }] }, narration: "Here is a pizza cut into three big slices. You have two of them." },
  { visual: set(12, 8), narration: "Now I cut every slice into four smaller slices. You still have the same pizza, just more slices." },
  { visual: { kind: "keep" }, narration: "So the top and the bottom both got bigger in the same way. Two thirds equals eight twelfths." },
  { visual: set(6, 4), narration: "Cut each big slice in two instead. Four of six slices is the same amount again." },
  { visual: set(2, 1), narration: "Now look at one half of a new pizza." },
];
export const demoRepairMeta = {
  phase: "repair", title: "Smaller pizza", goal: "Double top and bottom", approach: "simplify", reason: "The task was missed", assessment: null,
  check: { kind: "number", prompt: "One half is how many sixths?", rule: { operation: "value", value: 3 } },
} as const;
export const demoRepairMoments = [
  { visual: { kind: "bars", bars: [{ id: "pizza", label: "Pizza", parts: 2, shaded: 1 }] }, narration: "Let us take a pizza with two slices. One slice is yours." },
  { visual: set(4, 2), narration: "Cut both slices in half. Now there are four slices and two are yours." },
  { visual: { kind: "keep" }, narration: "The amount did not change." },
];
export const demoHandBackMeta = {
  phase: "return_to_problem", title: "Your task", goal: "Solve the original task", approach: "handoff", reason: "Arc ends", assessment: null, check: null,
} as const;
export const demoHandBackMoments = [{ visual: { kind: "keep" }, narration: "You worked really carefully. Now try your own task: you have everything you need." }];
