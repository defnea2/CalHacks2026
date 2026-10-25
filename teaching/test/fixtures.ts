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
