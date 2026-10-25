import type { CommandInput } from "../presentation/contracts";
import type { MathChange, MathVisualInput } from "../presentation/math/models";
import type { PlanningModel, PlanningRequest } from "./TeachingPlanner";
import type { StepInput, TeachingCheck, TeachingPhase } from "./contracts";

/** Authored, local demonstrations. These never pretend to be generated lessons. */
export const preparedLessons = [
  { id: "fractions", title: "Same amount. Different pieces.", topic: "Why are one half and two quarters equal?", description: "Split a chocolate bar and see why fractions can have different names.", durationSeconds: 60 },
  { id: "multiplication", title: "Build it. Group it. Multiply it.", topic: "Why does multiplication mean equal groups?", description: "Build rows of tiles, then discover the shortcut hiding in the picture.", durationSeconds: 60 },
  { id: "area", title: "A shape changes. Does its area?", topic: "Why does slanting a parallelogram keep its area?", description: "Slant, cut, and slide the same piece to uncover an area proof.", durationSeconds: 60 },
] as const;

export type PreparedLessonId = typeof preparedLessons[number]["id"];
type Moment = { narration: string; commands: CommandInput[] };
type VisualWithoutId = { [K in MathVisualInput["kind"]]: Omit<Extract<MathVisualInput, { kind: K }>, "id"> }[MathVisualInput["kind"]];
const visualId = "prepared-math";
const show = (visual: VisualWithoutId): CommandInput => ({ type: "show_math", visual: { ...visual, id: visualId } as MathVisualInput });
const update = (change: MathChange): CommandInput => ({ type: "update_math", id: visualId, change });
const moment = (narration: string, ...commands: CommandInput[]): Moment => ({ narration, commands });
const equation = (visible: boolean) => update({ type: "set_equation", visible });
const choice = (prompt: string, correct: string, other: string): TeachingCheck => ({
  kind: "choice", prompt, options: [{ id: "a", label: correct }, { id: "b", label: other }], correctOptionId: "a",
});

function assemble(request: PlanningRequest, topic: PreparedLessonId, phase: TeachingPhase,
  moments: Moment[], check: TeachingCheck | null, options: { exampleProblem?: string; approach?: StepInput["approach"] } = {}): StepInput {
  const id = "prepared-" + request.requestId;
  return {
    id, phase,
    learningGoal: topic === "fractions" ? "Explain equivalent fractions using equal wholes" : topic === "multiplication" ? "Interpret multiplication as equal groups" : "Explain area conservation by cutting and rearranging",
    approach: options.approach ?? (request.context.currentStep ? "continue" : "introduce"),
    rationale: "Prepared demonstration: teach a connected visual explanation, then use the submitted evidence to choose practice or reteaching.",
    ...(options.exampleProblem ? { exampleProblem: options.exampleProblem } : {}),
    beats: moments.map((item, index) => ({
      id: `${id}-${index}`,
      narration: item.narration + (index === moments.length - 1 && check ? " " + check.prompt : ""),
      cues: item.commands.length ? [{ id: `picture-${index}`, atMs: 0, commands: item.commands }] : [],
    })),
    check, evidenceToObserve: ["The answer submitted after the explanation", "Whether the learner requests another explanation"], assessment: null,
  };
}

function introduction(request: PlanningRequest, topic: PreparedLessonId): StepInput {
  if (topic === "fractions") return assemble(request, topic, "intuition", [
    moment("Imagine two identical chocolate bars. Each bar is one whole. We have shaded half of each, so both people get exactly the same amount of chocolate.", show({ kind: "bars", title: "Same chocolate, different pieces", bars: [{ id: "original", label: "Keep this half", parts: 2, shaded: 1 }, { id: "split", label: "Watch this half", parts: 2, shaded: 1 }] })),
    moment("Now cut every piece of the lower bar in half. There are four equal pieces instead of two. The shaded chocolate has not grown or disappeared.", update({ type: "set_bar", barId: "split", parts: 4, shaded: 2 })),
    moment("We call the upper share one half. We call the lower share two quarters. Count the pieces, then look at where the shaded region ends. It ends at the same place.", update({ type: "set_focus", target: "split" })),
    moment("Cut those pieces in half again. Now the whole has eight equal pieces, and our share covers four of them. More pieces can mean smaller pieces, rather than more chocolate.", update({ type: "set_bar", barId: "split", parts: 8, shaded: 4 }), update({ type: "set_focus", target: null })),
    moment("That is why one half and four eighths are equal. Multiply both the number of shaded pieces and the total number of pieces by the same number: the share stays the same.", equation(true)),
    moment("Keep the whole the same size when you compare. Now use the idea with six equal pieces.", equation(false)),
  ], choice("Which fraction is another name for one half?", "3 out of 6 equal pieces", "1 out of 3 equal pieces"));

  if (topic === "multiplication") return assemble(request, topic, "intuition", [
    moment("Let's build a little tile garden. This first row holds four tiles. Think of one row as one group, and the four tiles as what is inside that group.", show({ kind: "array", title: "Build equal groups", rows: 1, columns: 4 })),
    moment("Add a second row with the same four tiles. We have two groups now. The total grows by four, because we added everything inside another group.", update({ type: "set_array", rows: 2 })),
    moment("Here comes a third row. Counting the rows tells us how many groups there are. Counting across one row tells us how many tiles belong to each group.", update({ type: "set_array", rows: 3 })),
    moment("We can split the garden into two smaller patches without adding any tiles. Each patch has three groups of two. Together they still make our three groups of four.", update({ type: "set_array", splitAt: 2 })),
    moment("Three groups of four means four plus four plus four: twelve tiles. Multiplication is a shorter way to describe that repeated equal group. Three times four is twelve.", equation(true)),
    moment("Adding three and four would count the two labels, rather than all the tiles. Picture the whole rows when you choose.", equation(false), update({ type: "set_array", splitAt: null })),
  ], choice("Which addition describes three groups of four?", "4 + 4 + 4", "3 + 4"));

  return assemble(request, topic, "intuition", [
    moment("This rectangle is six units across and four units tall. Area means the amount of flat space it covers. Let's see what happens when we push its top sideways.", show({ kind: "parallelogram", title: "Same pieces, same area", base: 6, height: 4, shear: 0, stage: "slant" })),
    moment("The shape is now a parallelogram. Its side leans, but the bottom is still six units long. Its straight up-and-down height is still four, even though the leaning side is longer.", update({ type: "set_parallelogram", shear: 3 })),
    moment("Make a straight vertical cut to separate this triangular wedge. We have only cut the shape into two pieces. Every bit of its area is still here.", update({ type: "set_parallelogram", stage: "cut" })),
    moment("Watch the exact same wedge slide across to the other side. It fills the gap and makes a rectangle. We did not stretch, shrink, add, or throw away any piece.", update({ type: "set_parallelogram", stage: "reassembled" })),
    moment("The new rectangle is six units across and four units tall, so its area is twenty-four square units. The parallelogram has the same area because it contains exactly the same pieces.", equation(true)),
    moment("That is why a parallelogram's area is base times perpendicular height. The leaning side is not the height. Think about what the moving piece proved.", equation(false)),
  ], choice("Why did the area stay the same?", "We rearranged the same pieces without changing their sizes", "Every four-sided shape has the same area"));
}

function third(request: PlanningRequest, topic: PreparedLessonId): StepInput {
  const approach = "change_representation" as const;
  if (topic === "fractions") return assemble(request, topic, "intuition", [
    moment("Here is a grid of eight equal squares. The whole grid is one whole, so every square is one eighth of it.", show({ kind: "array", title: "Squares in a whole", rows: 2, columns: 4 })),
    moment("Slide a line down the middle. Each side holds four squares. Two equal sides means each side is one half of the grid.", update({ type: "set_array", splitAt: 2 })),
    moment("Look at one side. It has four of the eight squares, and it also has two of the four columns. Those are all names for the same half.", update({ type: "set_focus", target: "left" })),
  ], choice("Which is another name for one half of this grid?", "4 out of 8 squares", "1 out of 8 squares"), { approach });
  if (topic === "multiplication") return assemble(request, topic, "intuition", [
    moment("Let's jump along a number line. Each jump is one group of four. We start at zero, with no groups yet.", show({ kind: "number_line", title: "Jumps of four", min: 0, max: 12, markers: [{ id: "jump", label: "We are here", value: 0 }] })),
    moment("One jump of four lands on four. That is one group of four.", update({ type: "move_marker", markerId: "jump", value: 4 })),
    moment("Two jumps land on eight, and three jumps land on twelve. Three equal jumps of four make twelve.", update({ type: "move_marker", markerId: "jump", value: 12 })),
  ], choice("Where do three jumps of four land?", "On 12", "On 7"), { approach });
  return assemble(request, topic, "intuition", [
    moment("This rectangle is six units across and four units tall. Its area is twenty-four square units.", show({ kind: "geometry", title: "Cutting versus rearranging", shape: "rectangle", width: 6, height: 4 })),
    moment("If we throw half of it away, only twelve square units are left. Taking a piece away makes the area smaller.", update({ type: "set_geometry", width: 3 })),
    moment("Sliding a piece to a new spot is different, because nothing is thrown away. Put it all back and the area is twenty-four again.", update({ type: "set_geometry", width: 6 })),
  ], choice("What happens to area when a piece is only moved, not removed?", "It stays the same", "It gets smaller"), { approach });
}

const pictureCycle: Record<PreparedLessonId, string[]> = {
  fractions: ["bars", "number_line", "array"], multiplication: ["array", "bars", "number_line"], area: ["parallelogram", "array", "geometry"],
};
/** Each request for another picture moves to the next unused representation, wrapping to the original. */
function reteach(request: PlanningRequest, topic: PreparedLessonId): StepInput {
  const currentKind = request.context.canvas.math?.visual.kind ?? "";
  const cycle = pictureCycle[topic];
  const target = cycle[(cycle.indexOf(currentKind) + 1) % cycle.length];
  const approach = "change_representation" as const;
  if (target === cycle[0]) return { ...introduction(request, topic), approach, rationale: "The learner requested support; revisit the same concept through the original picture." };
  if (target === cycle[2]) return third(request, topic);
  if (topic === "fractions") return assemble(request, topic, "intuition", [
    moment("Let's look at the amount instead of just the numbers. This line is one whole, from zero to one. The upper point marks the halfway amount.", show({ kind: "number_line", title: "Fractions are amounts", min: 0, max: 1, markers: [{ id: "half", label: "One half", value: 0.5 }, { id: "share", label: "Our share", value: 0.25 }] })),
    moment("Our share starts at one quarter. One quarter is only halfway to the half mark. So one quarter and one half are different amounts.", update({ type: "set_focus", target: "share" })),
    moment("Add another quarter. Now our share reaches the half mark exactly. Two quarters and one half have different names, but land at the same amount.", update({ type: "move_marker", markerId: "share", value: 0.5 })),
    moment("The bottom number tells us the size of the pieces. The top number tells us how many pieces we have. Check both, and keep the whole the same.", update({ type: "set_focus", target: null })),
  ], choice("Which share reaches the halfway mark?", "Two quarters", "One quarter"), { approach });
  if (topic === "multiplication") return assemble(request, topic, "intuition", [
    moment("Let's use trays instead of a tile garden. There are three trays. Each tray has space for four objects. The number of trays and the objects inside them tell us different things.", show({ kind: "bars", title: "Count what is inside each group", bars: [{ id: "one", label: "Tray 1", parts: 4, shaded: 0 }, { id: "two", label: "Tray 2", parts: 4, shaded: 0 }, { id: "three", label: "Tray 3", parts: 4, shaded: 0 }] })),
    moment("Fill the first tray. We have four objects, not one. One counts the tray; four counts the objects we are collecting.", update({ type: "set_bar", barId: "one", shaded: 4 })),
    moment("Fill the other two trays with four objects each. Our total is four, then eight, then twelve. Each extra group adds another four.", update({ type: "set_bar", barId: "two", shaded: 4 }), update({ type: "set_bar", barId: "three", shaded: 4 })),
    moment("Three times four describes these three equal groups. To add it, repeat the amount inside a tray once for every tray.", update({ type: "set_focus", target: "two" })),
  ], choice("Which addition counts all the objects in the three trays?", "4 + 4 + 4", "3 + 4"), { approach });
  return assemble(request, topic, "intuition", [
    moment("Let's count the flat space with square tiles. This rectangle has four rows, with six square units in each row. The area counts every square unit it covers.", show({ kind: "array", title: "Area counts square units", rows: 4, columns: 6 })),
    moment("Split the picture into two patches. Each patch contains four rows of three. The gap is just there to let us see the pieces separately.", update({ type: "set_array", splitAt: 3 })),
    moment("There are twelve tiles on each side, making twenty-four altogether. Cutting and moving a patch cannot change the number of tiles, as long as none are lost or overlap.", equation(true)),
    moment("That is the same idea behind sliding the triangle: we rearranged existing space. The area changes only if we add, remove, stretch, or overlap part of it.", equation(false), update({ type: "set_array", splitAt: null })),
  ], choice("What happens to the total area when we only rearrange the pieces without overlap?", "It stays the same", "It must increase"), { approach });
}

function practice(request: PlanningRequest, topic: PreparedLessonId, phase: "solo" | "transfer"): StepInput {
  const used = new Set(request.context.usedExampleProblems.map(text => text.toLowerCase()));
  if (request.context.session.originalQuestion) used.add(request.context.session.originalQuestion.toLowerCase());
  const fresh = <T,>(values: T[], label: (value: T) => string): T => {
    const result = values.find(value => !used.has(label(value).toLowerCase()));
    if (result === undefined) throw new Error("You have finished this prepared lesson's practice. Start another lesson or ask the live tutor for a new topic.");
    return result;
  };
  const opening = request.context.evidence.at(-1)?.outcome === "unclear" ? "I could not tell which answer you meant. Try this fresh example when you are ready." : phase === "transfer" ? "Now take the same idea into a new situation." : "You have seen the idea. Try a fresh example on your own.";
  if (topic === "fractions") {
    const label = (parts: number) => phase === "transfer" ? `A ribbon is cut into ${parts} equal lengths. How many lengths make half the ribbon?` : `How many of ${parts} equal pieces make one half?`;
    const parts = fresh(phase === "transfer" ? [10, 6, 12, 8, 4] : [8, 4, 6, 12, 10], label);
    return assemble(request, topic, phase, [moment(opening, show({ kind: "bars", title: phase === "transfer" ? "Share a ribbon equally" : "Make one half", bars: [{ id: "whole", label: "One whole", parts, shaded: 0 }] }))], { kind: "number", prompt: label(parts), rule: { operation: "quotient", left: parts, right: 2 } }, { approach: "challenge", exampleProblem: label(parts) });
  }
  if (topic === "multiplication") {
    const label = ([r, c]: number[]) => phase === "transfer" ? `${r} tables each need ${c} cups. How many cups are needed?` : `How many tiles are in ${r} groups of ${c}?`;
    const [r, c] = fresh(phase === "transfer" ? [[4, 3], [5, 2], [3, 6], [6, 4]] : [[2, 5], [3, 3], [4, 4], [5, 3]], label);
    return assemble(request, topic, phase, [moment(opening, show({ kind: "array", title: phase === "transfer" ? "Set the tables" : "Count equal groups", rows: r, columns: c }))], { kind: "number", prompt: label([r, c]), rule: { operation: "product", left: r, right: c } }, { approach: "challenge", exampleProblem: label([r, c]) });
  }
  const label = ([b, h]: number[]) => phase === "transfer" ? `A slanted garden has base ${b} metres and perpendicular height ${h} metres. What is its area in square metres?` : `A parallelogram has base ${b} and perpendicular height ${h}. What is its area?`;
  const [b, h] = fresh(phase === "transfer" ? [[7, 3], [4, 5], [8, 3], [5, 4]] : [[5, 3], [4, 3], [7, 2], [6, 2]], label);
  return assemble(request, topic, phase, [moment(opening, show({ kind: "parallelogram", title: phase === "transfer" ? "Measure the slanted garden" : "Use the perpendicular height", base: b, height: h, shear: 2, stage: "slant" }))], { kind: "number", prompt: label([b, h]), rule: { operation: "product", left: b, right: h } }, { approach: "challenge", exampleProblem: label([b, h]) });
}

/** Zero network latency, deterministic branching, and the same validation/playback contract as live lessons. */
export const preparedPlanningModel: PlanningModel = async (request, signal) => {
  if (signal?.aborted) throw new Error("Planning cancelled.");
  const topic = preparedLessons.find(item => item.topic === request.context.session.topic)?.id;
  if (!topic) throw new Error("Choose a prepared lesson from the catalog, or use the live tutor for another topic.");
  const current = request.context.currentStep;
  const evidence = request.context.evidence.filter(item => item.stepId === current?.id).at(-1);
  if (!current) return introduction(request, topic);
  if (evidence?.response.kind === "help" && evidence.response.request === "repeat") {
    const id = "prepared-" + request.requestId;
    return { ...current, id, approach: "hint", assessment: null, beats: current.beats.map((beat, i) => ({ ...beat, id: `${id}-${i}` })) };
  }
  if (evidence?.response.kind === "help" || evidence?.outcome === "incorrect") return reteach(request, topic);
  if (evidence?.outcome === "unclear" || !evidence) {
    return current.phase === "solo" || current.phase === "transfer" ? practice(request, topic, current.phase) : introduction(request, topic);
  }
  if (current.phase === "transfer") return assemble(request, topic, "return_to_problem", [moment("You used the idea in a new situation. Keep the picture in mind as you try your own question. Explain what each number means and why your steps make sense.", { type: "clear", title: "Take the idea with you" })], null, { approach: "handoff" });
  return practice(request, topic, current.phase === "solo" ? "transfer" : "solo");
};
