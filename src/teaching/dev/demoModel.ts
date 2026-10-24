import type { CommandInput } from "../../presentation/contracts";
import { getFixture } from "../../shared/fixtures";
import type { PlanningRequest } from "../TeachingPlanner";
import type { StepInput, TeachingCheck, TeachingPhase } from "../contracts";

export type DemoTopic = "multiplication" | "decimals" | "water";
export const demoTopics = [
  {
    id: "multiplication",
    label: "Why does multiplication mean equal groups?",
    homework: "What is 7 × 8?",
  },
  {
    id: "decimals",
    label: "Why is 0.4 greater than 0.35?",
    homework: "Compare 0.8 and 0.75.",
  },
  {
    id: "water",
    label: "How does a puddle become rain?",
    homework: "Explain why a puddle dries faster in sunshine.",
  },
] as const;
const choice = (
  prompt: string,
  first: string,
  second: string,
  correctOptionId = "a",
): TeachingCheck => ({
  kind: "choice",
  prompt,
  options: [
    { id: "a", label: first },
    { id: "b", label: second },
  ],
  correctOptionId,
});
const count = (prompt: string, left: number, right: number): TeachingCheck => ({
  kind: "number",
  prompt,
  rule: { operation: "product", left, right },
});
const array = (
  rows: number,
  columns: number,
  showEquation = false,
): CommandInput[] => [
  {
    type: "show_math",
    visual: {
      id: "groups",
      kind: "array",
      title: "Equal groups, one total",
      rows,
      columns,
      showEquation,
    },
  },
];
const line = (a: number, b: number): CommandInput[] => [
  {
    type: "show_math",
    visual: {
      id: "decimals",
      kind: "number_line",
      title: "Compare on the same scale",
      min: 0,
      max: 1,
      markers: [
        { id: "a", label: String(a), value: a },
        { id: "b", label: String(b), value: b },
      ],
    },
  },
];
const water = (): CommandInput[] => [
  {
    type: "show_activity",
    sceneId: "water-explanation",
    activity: { ...getFixture("water"), allowedInteractions: [] },
  },
];

function identify(topic: string): DemoTopic {
  if (/multipli|equal groups/i.test(topic)) return "multiplication";
  if (/decimal|0\.4|0\.35/i.test(topic)) return "decimals";
  if (/water|puddle|rain/i.test(topic)) return "water";
  throw new Error(
    "Local fixtures cover multiplication, decimals and the water cycle. Use Model endpoint mode for an open-ended topic.",
  );
}
function phaseFor(request: PlanningRequest): TeachingPhase {
  const current = request.context.currentStep;
  const last = request.context.evidence
    .filter((e) => e.stepId === current?.id)
    .at(-1);
  if (!current) return "diagnose";
  if (last?.response.kind === "help") return "intuition";
  if (last?.outcome === "unclear") return current.phase;
  if (last?.outcome === "incorrect")
    return current.phase === "diagnose" ? "intuition" : "repair";
  const next: Record<TeachingPhase, TeachingPhase> = {
    diagnose: "intuition",
    intuition: "formalize",
    formalize: "worked_example",
    worked_example: "repair",
    repair: "solo",
    solo: "transfer",
    transfer: "return_to_problem",
    return_to_problem: "return_to_problem",
  };
  return next[current.phase];
}

/** Deliberately scripted offline fixtures. Production must inject the real tutor model. */
export async function demoPlanningModel(
  request: PlanningRequest,
): Promise<StepInput> {
  const topic = identify(request.context.session.topic);
  const phase = phaseFor(request);
  const current = request.context.currentStep;
  const last = request.context.evidence
    .filter((e) => e.stepId === current?.id)
    .at(-1);
  const help = last?.response.kind === "help" ? last.response.request : null;
  let narration = "";
  let commands: CommandInput[] = [];
  let check: TeachingCheck | null = null;
  let exampleProblem: string | undefined;
  let approach: StepInput["approach"] = !current
    ? "introduce"
    : help === "another_way"
      ? "change_representation"
      : help === "hint"
        ? "hint"
        : help
          ? "simplify"
          : ["solo", "transfer"].includes(phase)
            ? "challenge"
            : "continue";
  if (help === "repeat" && current) {
    const id = "repeat-" + request.requestId;
    return {
      ...current,
      id,
      approach: "hint",
      assessment: null,
      beats: current.beats.map((beat, i) => ({ ...beat, id: id + "-" + i })),
    };
  }
  if (topic === "multiplication") {
    commands = array(2, 3);
    switch (phase) {
      case "diagnose":
        check = choice(
          "Which describes two groups of three?",
          "3 + 3",
          "2 + 3",
        );
        narration = "Before we begin, think about what a group means.";
        break;
      case "intuition":
        check = count("How many objects are in two groups of three?", 2, 3);
        narration =
          "Imagine two baskets, each holding three apples. Count the apples in each row.";
        break;
      case "formalize":
        commands = array(2, 3, true);
        narration =
          "Two groups of three means three plus three. We write that as two times three, which equals six.";
        break;
      case "worked_example":
        commands = array(3, 4, true);
        exampleProblem = "How many are three groups of four?";
        narration =
          "For a different example, three groups of four means four plus four plus four: twelve.";
        break;
      case "repair":
        commands = array(3, 5);
        check = choice(
          "Someone says three groups of five is eight. What should they count?",
          "Five three times",
          "Three plus five",
        );
        narration =
          "Let's repair the idea. Adding the two labels misses the objects inside the groups.";
        break;
      case "solo": {
        const r = [5, 4, 6, 7, 8, 9, 10, 11].find(
          (n) =>
            !request.context.usedExampleProblems.includes(
              "How many are " + n + " groups of four?",
            ),
        );
        if (!r)
          throw new Error(
            "Local practice examples exhausted. Switch to a model for more.",
          );
        commands = array(r, 4);
        exampleProblem = "How many are " + r + " groups of four?";
        check = count(
          "How many objects are in " + r + " groups of four?",
          r,
          4,
        );
        narration =
          "Try a fresh example on your own. Use the picture if it helps.";
        break;
      }
      case "transfer":
        commands = array(6, 3);
        exampleProblem = "Six trays hold three cups each. How many cups?";
        check = count(
          "Six trays hold three cups each. How many cups are there?",
          6,
          3,
        );
        narration = "Now try the same idea in a new setting.";
        break;
      case "return_to_problem":
        break;
    }
    if (help === "another_way") {
      const activity = getFixture("groups");
      commands =
        request.context.canvas.activity?.activity.kind === "objects_groups"
          ? array(2, 3)
          : [
              {
                type: "show_activity",
                sceneId: "apple-baskets",
                activity: {
                  ...activity,
                  title: "Move the apples into baskets",
                  prompt: "Put three apples in each basket.",
                  objects:
                    activity.kind === "objects_groups"
                      ? activity.objects.map((o, i) => ({
                          ...o,
                          label: "Apple " + (i + 1),
                          icon: "dot" as const,
                        }))
                      : [],
                  groups: [
                    { id: "basket-a", label: "Basket A" },
                    { id: "basket-b", label: "Basket B" },
                  ],
                  kind: "objects_groups",
                  allowedInteractions: ["select", "place", "unplace"],
                },
              },
            ];
      narration =
        "Let's use a different picture. We can organize six objects into two groups of three.";
    }
  } else if (topic === "decimals") {
    commands = line(0.4, 0.35);
    switch (phase) {
      case "diagnose":
        check = choice("Which number is larger: 0.4 or 0.35?", "0.4", "0.35");
        narration =
          "We will compare amounts, not the length of the written number.";
        commands = [{ type: "clear", title: "What does a decimal tell us?" }];
        break;
      case "intuition":
        check = choice(
          "Which point is farther along the equal-scale lines?",
          "0.4",
          "0.35",
        );
        narration =
          "Both lines run from zero to one. Four tenths reaches farther than thirty-five hundredths.";
        break;
      case "formalize":
        narration =
          "Four tenths is forty hundredths. Writing zero point four zero keeps the value the same. Forty hundredths is greater than thirty-five hundredths.";
        break;
      case "worked_example":
        commands = line(0.6, 0.45);
        exampleProblem = "Compare 0.6 and 0.45.";
        narration =
          "For a different example, six tenths is sixty hundredths, so it is greater than forty-five hundredths.";
        break;
      case "repair":
        commands = line(0.2, 0.18);
        check = choice(
          "Someone says 0.18 is larger because eighteen is larger than two. What fixes this?",
          "Compare 20 hundredths with 18 hundredths",
          "Count the written digits",
        );
        narration = "The digits must describe pieces of the same size.";
        break;
      case "solo": {
        const pair = [
          [0.7, 0.65],
          [0.9, 0.85],
          [0.5, 0.45],
          [0.6, 0.55],
        ].find(
          ([a, b]) =>
            !request.context.usedExampleProblems.includes(
              "Compare " + a + " and " + b + ".",
            ),
        );
        if (!pair)
          throw new Error(
            "Local practice examples exhausted. Switch to a model for more.",
          );
        const [a, b] = pair;
        commands = line(a, b);
        exampleProblem = "Compare " + a + " and " + b + ".";
        check = choice(
          "Which is larger: " + a + " or " + b + "?",
          String(a),
          String(b),
        );
        narration = "Try a fresh comparison yourself.";
        break;
      }
      case "transfer":
        commands = [{ type: "clear", title: "Compare lengths" }];
        exampleProblem = "Which ribbon is longer: 0.3 m or 0.27 m?";
        check = choice(
          "Which ribbon is longer: 0.3 metres or 0.27 metres?",
          "0.3 metres",
          "0.27 metres",
        );
        narration =
          "Use the same idea to compare two lengths without the number lines.";
        break;
      case "return_to_problem":
        break;
    }
    if (help === "another_way") {
      commands =
        request.context.canvas.math?.visual.kind === "bars"
          ? line(0.5, 0.25)
          : [
              {
                type: "show_math",
                visual: {
                  id: "decimal-bars",
                  kind: "bars",
                  title: "Decimals as parts of a whole",
                  bars: [
                    { id: "a", label: "0.5 — one half", parts: 2, shaded: 1 },
                    {
                      id: "b",
                      label: "0.25 — one quarter",
                      parts: 4,
                      shaded: 1,
                    },
                  ],
                },
              },
            ];
      check = choice("Which amount is larger: 0.5 or 0.25?", "0.5", "0.25");
      narration =
        "Let's start with halves and quarters of equal wholes. A half is zero point five. A quarter is zero point two five.";
    }
  } else {
    commands = water();
    switch (phase) {
      case "diagnose":
        commands = [{ type: "clear", title: "Where does puddle water go?" }];
        check = choice(
          "What helps puddle water turn into water vapour?",
          "Warmth from the sun",
          "The water becoming rock",
        );
        narration = "Let's start with a puddle you might have seen.";
        break;
      case "intuition":
        check = choice(
          "When a puddle dries, can its water enter the air?",
          "Yes, as water vapour",
          "No, the water is destroyed",
        );
        narration =
          "Liquid water can become water vapour in the air. We cannot see the water vapour itself.";
        break;
      case "formalize":
        narration =
          "Liquid water becoming water vapour is evaporation. When water vapour cools and becomes tiny liquid droplets, that is condensation. Clouds contain tiny droplets or ice crystals.";
        break;
      case "worked_example":
        exampleProblem = "A wet path dries after the sun comes out.";
        narration =
          "Think about a wet path warming in sunshine. Some liquid water evaporates into the air. Later, cooling water vapour can condense into droplets.";
        break;
      case "repair":
        check = choice(
          "Someone says a cloud is made only of invisible water vapour. What should change?",
          "Clouds contain tiny droplets or ice crystals",
          "Clouds are made of smoke",
        );
        narration = "Let's repair one part of the explanation.";
        break;
      case "solo": {
        const setting = ["a cold glass", "a cold window", "a chilled metal bottle"].find(
          (s) => !request.context.usedExampleProblems.includes(
            "Water appears on the outside of " + s + ". Name the change.",
          ),
        );
        if (!setting) throw new Error("Local practice examples exhausted. Switch to a model for more.");
        commands = [{ type: "clear", title: "Name the change" }];
        exampleProblem = "Water appears on the outside of " + setting + ". Name the change.";
        check = choice(
          "Water vapour becomes droplets outside " + setting + ". Which change is this?",
          "Condensation",
          "Evaporation",
        );
        narration =
          "Try a new example on your own.";
        break;
      }
      case "transfer":
        commands = [{ type: "clear", title: "Try the idea somewhere new" }];
        exampleProblem =
          "A damp shirt dries on a washing line. Where can the water go?";
        check = choice(
          "A damp shirt dries. Where can its water go?",
          "Into the air as water vapour",
          "It stops existing",
        );
        narration = "Use the same idea for a different everyday event.";
        break;
      case "return_to_problem":
        break;
    }
    if (help === "another_way") {
      if (request.context.canvas.activity)
        commands = [
          { type: "clear", title: "Follow one drop" },
          {
            type: "add",
            nodes: [
              {
                id: "drop",
                kind: "object",
                icon: "drop",
                label: "Liquid water",
                x: 280,
                y: 300,
                width: 200,
                height: 150,
              },
              {
                id: "air",
                kind: "label",
                label: "Water vapour in air",
                x: 700,
                y: 300,
                width: 330,
                height: 140,
              },
            ],
          },
          {
            type: "connect",
            edges: [
              {
                id: "evaporation",
                from: "drop",
                to: "air",
                label: "Evaporation",
              },
            ],
          },
        ];
      narration =
        "Let's follow just one change: liquid water becoming water vapour in the air.";
    }
  }
  if (phase === "return_to_problem") {
    approach = "handoff";
    check = null;
    commands = [{ type: "clear", title: "Your turn to use the idea" }];
    narration =
      "You have tried the idea on other examples. Return to your original question and try it yourself. Explain why your steps make sense.";
  }
  if (last?.outcome === "unclear" && check)
    narration =
      "I could not tell which answer you meant. Let's clarify just this question.";
  if (help === "simpler") narration = "Let's take a smaller step. " + narration;
  if (check) narration += " " + check.prompt;
  const id = "step-" + request.requestId;
  return {
    id,
    phase,
    learningGoal:
      topic === "multiplication"
        ? "Interpret multiplication as equal groups"
        : topic === "decimals"
          ? "Compare decimals using equal place values"
          : "Distinguish evaporation from condensation",
    approach,
    rationale: last
      ? "Adapt to the latest recorded learner response."
      : "Establish a starting point before explaining.",
    exampleProblem,
    beats: [
      {
        id: id + "-beat",
        narration,
        cues: [{ id: "visual", atMs: 0, commands }],
      },
    ],
    check,
    evidenceToObserve: [
      "Response to the explicit check",
      "Whether help was requested",
    ],
    assessment: null,
  };
}
