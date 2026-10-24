import type { BeatInput, CommandInput } from "../contracts";
import { getFixture, type FixtureKey } from "../../shared/fixtures";
export interface RehearsalStep {
  title: string;
  beat: BeatInput;
}
const step = (
  id: string,
  title: string,
  narration: string,
  commands: CommandInput[],
): RehearsalStep => ({
  title,
  beat: {
    id,
    narration,
    cues: [
      {
        id: `${id}-cue`,
        atMs: 0,
        commands: [...commands, { type: "note", text: narration }],
      },
    ],
  },
});
const change = (
  id: string,
  value: Extract<CommandInput, { type: "update_math" }>["change"],
): CommandInput => ({ type: "update_math", id, change: value });
export function arrayRehearsal(
  rows = 3,
  columns = 14,
  splitAt = 10,
): RehearsalStep[] {
  return [
    step(
      "array-show",
      "Build the array",
      `Here are ${rows} groups of ${columns}. We can make this easier to count.`,
      [
        {
          type: "show_math",
          visual: {
            id: "array",
            kind: "array",
            title: "Multiplication: parts and whole",
            rows,
            columns,
          },
        },
      ],
    ),
    step(
      "array-split",
      "Split into smaller pieces",
      `Split each row into ${splitAt} and ${columns - splitAt}. The total number of cells stays the same.`,
      [change("array", { type: "set_array", splitAt })],
    ),
    step(
      "array-focus",
      "Focus on the first part",
      `Look at the first part: ${rows} groups of ${splitAt}.`,
      [change("array", { type: "set_focus", target: "left" })],
    ),
    step(
      "array-equation",
      "Connect the picture to symbols",
      "Count the two parts, then add them together. The equation describes the picture.",
      [
        change("array", { type: "set_focus", target: null }),
        change("array", { type: "set_equation", visible: true }),
      ],
    ),
    step(
      "array-more",
      "What if we add a group?",
      "Keep the same split and add one more group. Both parts grow together.",
      [change("array", { type: "set_array", rows: rows + 1 })],
    ),
    step(
      "array-explore",
      "Invite the learner",
      "Try changing the groups or moving the split. What changes? What stays the same?",
      [change("array", { type: "set_interaction", enabled: true })],
    ),
  ];
}
export function numberLineRehearsal(): RehearsalStep[] {
  return [
    step(
      "line-show",
      "Place two decimals",
      "These lines use exactly the same scale. Compare where the two numbers land.",
      [
        {
          type: "show_math",
          visual: {
            id: "line",
            kind: "number_line",
            title: "Which decimal is farther along?",
            min: 0,
            max: 1,
            markers: [
              { id: "first", label: "First number", value: 0.4 },
              { id: "second", label: "Second number", value: 0.35 },
            ],
          },
        },
      ],
    ),
    step(
      "line-focus",
      "Direct attention",
      "Four tenths reaches farther along than thirty-five hundredths.",
      [change("line", { type: "set_focus", target: "first" })],
    ),
    step(
      "line-move",
      "Move a marker",
      "Now the second number moves to six tenths. Its position changes with its value.",
      [
        change("line", { type: "move_marker", markerId: "second", value: 0.6 }),
        change("line", { type: "set_focus", target: "second" }),
      ],
    ),
    step(
      "line-explore",
      "Invite the learner",
      "Move either point and compare their positions. You can also use the arrow keys.",
      [
        change("line", { type: "set_focus", target: null }),
        change("line", { type: "set_equation", visible: true }),
        change("line", { type: "set_interaction", enabled: true }),
      ],
    ),
  ];
}
export function barRehearsal(): RehearsalStep[] {
  return [
    step(
      "bars-show",
      "Show equal wholes",
      "These bars are the same size. We have coloured one half and one quarter.",
      [
        {
          type: "show_math",
          visual: {
            id: "bars",
            kind: "bars",
            title: "Fractions: equal wholes",
            bars: [
              { id: "a", label: "First whole", parts: 2, shaded: 1 },
              { id: "b", label: "Second whole", parts: 4, shaded: 1 },
            ],
          },
        },
      ],
    ),
    step(
      "bars-change",
      "Make equivalent amounts",
      "Colour one more quarter. Two quarters now cover the same amount as one half.",
      [
        change("bars", { type: "set_bar", barId: "b", shaded: 2 }),
        change("bars", { type: "set_focus", target: "b" }),
      ],
    ),
    step(
      "bars-equation",
      "Connect to the quantities",
      "Different numbers of pieces can describe the same amount when the wholes are equal.",
      [change("bars", { type: "set_equation", visible: true })],
    ),
    step(
      "bars-explore",
      "Invite the learner",
      "Try colouring and partitioning the bars. Watch how the comparison changes.",
      [
        change("bars", { type: "set_focus", target: null }),
        change("bars", { type: "set_interaction", enabled: true }),
      ],
    ),
  ];
}
export function activityRehearsal(key: FixtureKey): RehearsalStep[] {
  const activity = getFixture(key);
  return [
    step(`activity-${key}`, "Open an interactive activity", activity.prompt, [
      { type: "show_activity", sceneId: `rehearsal-${key}`, activity },
    ]),
  ];
}
