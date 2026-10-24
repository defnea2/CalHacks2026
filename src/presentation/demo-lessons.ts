import type { BeatInput, NodeInput } from "./contracts";

export interface DemoLesson {
  id: string;
  title: string;
  beats: BeatInput[];
  retry: BeatInput;
  success: BeatInput;
  answerId: string;
}
const object = (
  id: string,
  label: string,
  icon: NodeInput["icon"],
  x: number,
  y: number,
  tone: NodeInput["tone"] = "sky",
  width = 180,
  height = 155,
): NodeInput => ({
  id,
  kind: "object",
  label,
  icon,
  x,
  y,
  width,
  height,
  tone,
});
const cue = (
  id: string,
  atMs: number,
  commands: BeatInput["cues"][number]["commands"],
) => ({ id, atMs, commands });
const waterChoices = ["puddle", "sun", "cloud", "rain"];
const water: DemoLesson = {
  id: "water",
  title: "Where does a puddle go?",
  answerId: "rain",
  beats: [
    {
      id: "water-begin",
      narration:
        "Have you ever wondered where a puddle goes? Let’s follow a drop of water.",
      cues: [
        cue("begin", 0, [
          { type: "clear", title: "A drop’s round trip" },
          {
            type: "add",
            nodes: [
              object(
                "puddle",
                "Liquid water",
                "drop",
                200,
                400,
                "sky",
                210,
                165,
              ),
            ],
          },
          { type: "point", id: "puddle", label: "Our story starts here" },
        ]),
        cue("wonder", 2200, [
          { type: "note", text: "The water has a journey to make." },
        ]),
      ],
    },
    {
      id: "water-rise",
      narration:
        "The sun warms the water. Some liquid water becomes invisible water vapour, and rises into the air.",
      cues: [
        cue("warm", 0, [
          { type: "point", id: null },
          {
            type: "add",
            nodes: [object("sun", "Sun", "sun", 200, 155, "sun", 155, 145)],
          },
          { type: "highlight", ids: ["sun"] },
          {
            type: "connect",
            edges: [
              { id: "sun-water", from: "sun", to: "puddle", label: "warms" },
            ],
          },
        ]),
        cue("vapour", 2200, [
          {
            type: "add",
            nodes: [
              object(
                "vapour",
                "Water vapour",
                "dot",
                505,
                400,
                "lilac",
                190,
                150,
              ),
            ],
          },
          { type: "highlight", ids: ["vapour"] },
          {
            type: "note",
            text: "Evaporation: liquid water becomes an invisible gas.",
          },
        ]),
        cue("rise", 3900, [
          { type: "update", id: "vapour", patch: { y: 155 } },
          {
            type: "connect",
            edges: [
              { id: "rise", from: "puddle", to: "vapour", label: "evaporates" },
            ],
          },
        ]),
      ],
    },
    {
      id: "water-cloud",
      narration:
        "Higher up, water vapour cools. It changes into tiny liquid droplets, which gather into a cloud.",
      cues: [
        cue("cloud", 0, [
          {
            type: "add",
            nodes: [
              object(
                "cloud",
                "Cloud droplets",
                "cloud",
                810,
                155,
                "sky",
                210,
                155,
              ),
            ],
          },
          {
            type: "connect",
            edges: [
              { id: "condense", from: "vapour", to: "cloud", label: "cools" },
            ],
          },
          { type: "highlight", ids: ["cloud"] },
        ]),
        cue("liquid", 2300, [
          { type: "point", id: "cloud", label: "Tiny liquid droplets" },
          {
            type: "note",
            text: "Condensation: water vapour becomes liquid droplets.",
          },
        ]),
      ],
    },
    {
      id: "water-rain",
      narration:
        "When droplets grow heavy enough, they fall as rain. The water returns, and its journey can start again.",
      cues: [
        cue("fall", 0, [
          { type: "point", id: null },
          { type: "highlight", ids: ["cloud"] },
          { type: "note", text: "Heavy droplets fall from clouds as rain." },
        ]),
        cue("rain", 1500, [
          {
            type: "add",
            nodes: [object("rain", "Rain", "drop", 810, 400, "sky", 180, 165)],
          },
          {
            type: "connect",
            edges: [{ id: "falls", from: "cloud", to: "rain", label: "falls" }],
          },
          { type: "highlight", ids: ["rain"] },
        ]),
        cue("return", 3500, [
          {
            type: "connect",
            edges: [
              { id: "collects", from: "rain", to: "puddle", label: "collects" },
            ],
          },
          { type: "note", text: "Up as vapour. Down as rain. Around again." },
        ]),
      ],
    },
    {
      id: "water-question",
      narration:
        "Your turn. Which part of our picture shows water falling back to the ground? Tap it.",
      cues: [
        cue("ask", 0, [
          { type: "highlight", ids: [] },
          { type: "note", text: "Which part shows water falling back down?" },
        ]),
      ],
      question: {
        prompt: "Which part shows water falling back to the ground?",
        nodeIds: waterChoices,
      },
    },
  ],
  retry: {
    id: "water-retry",
    narration:
      "Let’s trace the journey down from the cloud. Which part shows water falling?",
    cues: [
      cue("hint", 0, [
        { type: "point", id: "cloud", label: "Follow the arrow down" },
        {
          type: "note",
          text: "Start at the cloud, then follow the water down.",
        },
      ]),
    ],
    question: {
      prompt: "Which part shows water falling?",
      nodeIds: waterChoices,
    },
  },
  success: {
    id: "water-success",
    narration:
      "Yes! Rain carries liquid water back down. The same water can travel around this cycle again and again.",
    cues: [
      cue("feedback", 0, [
        { type: "point", id: null },
        { type: "highlight", ids: ["rain"] },
        {
          type: "note",
          text: "Rain brings the water back. The cycle keeps going.",
        },
      ]),
    ],
  },
};

const seeds = Array.from({ length: 12 }, (_, i) =>
  object(
    `seed-${i + 1}`,
    "",
    "leaf",
    100 + (i % 6) * 160,
    190 + Math.floor(i / 6) * 140,
    "mint",
    85,
    85,
  ),
);
const groups: DemoLesson = {
  id: "groups",
  title: "A shortcut for counting",
  answerId: "four",
  beats: [
    {
      id: "groups-begin",
      narration:
        "Here are twelve seeds. We could count them one at a time. But there is another way to see them.",
      cues: [
        cue("seeds", 0, [
          { type: "clear", title: "See the groups. See the total." },
          { type: "add", nodes: seeds },
          { type: "note", text: "Twelve seeds. How could we organise them?" },
        ]),
      ],
    },
    {
      id: "groups-arrange",
      narration:
        "Let’s arrange our seeds into three equal groups. Watch how they move. Each group gets the same number.",
      cues: [
        cue("groups", 0, [
          {
            type: "add",
            nodes: [
              object("group-a", "Group A", "leaf", 180, 120, "mint", 180, 115),
              object("group-b", "Group B", "leaf", 500, 120, "lilac", 180, 115),
              object("group-c", "Group C", "leaf", 820, 120, "sun", 180, 115),
            ],
          },
        ]),
        cue(
          "move",
          1300,
          seeds.map((seed, i) => ({
            type: "update" as const,
            id: seed.id,
            patch: {
              x: 130 + Math.floor(i / 4) * 320 + (i % 2) * 100,
              y: 270 + Math.floor((i % 4) / 2) * 105,
            },
          })),
        ),
        cue("equal", 3800, [
          { type: "note", text: "Same seeds. Three equal groups." },
        ]),
      ],
    },
    {
      id: "groups-count",
      narration:
        "There are four seeds in each group. Three groups of four make twelve. That is what three times four means.",
      cues: [
        cue("four", 0, [
          { type: "highlight", ids: seeds.slice(0, 4).map((seed) => seed.id) },
          { type: "point", id: "group-a", label: "Four in each group" },
        ]),
        cue("equation", 2800, [
          {
            type: "add",
            nodes: [
              {
                id: "equation",
                kind: "label",
                label: "3 × 4 = 12",
                x: 500,
                y: 490,
                width: 500,
                height: 60,
                tone: "ink",
              },
            ],
          },
          {
            type: "note",
            text: "Multiplication is a way to count equal groups.",
          },
        ]),
      ],
    },
    {
      id: "groups-question",
      narration:
        "Imagine adding one more equal group. How many extra seeds would we need? Choose a number.",
      cues: [
        cue("ask", 0, [
          { type: "point", id: null },
          { type: "highlight", ids: [] },
          { type: "remove", ids: ["equation"] },
          {
            type: "add",
            nodes: [
              {
                id: "three",
                kind: "shape",
                shape: "circle",
                label: "3",
                x: 360,
                y: 500,
                width: 85,
                height: 85,
                tone: "lilac",
              },
              {
                id: "four",
                kind: "shape",
                shape: "circle",
                label: "4",
                x: 500,
                y: 500,
                width: 85,
                height: 85,
                tone: "mint",
              },
              {
                id: "twelve",
                kind: "shape",
                shape: "circle",
                label: "12",
                x: 640,
                y: 500,
                width: 85,
                height: 85,
                tone: "sun",
              },
            ],
          },
          {
            type: "note",
            text: "One more equal group needs how many extra seeds?",
          },
        ]),
      ],
      question: {
        prompt: "How many extra seeds make one more equal group?",
        nodeIds: ["three", "four", "twelve"],
      },
    },
  ],
  retry: {
    id: "groups-retry",
    narration:
      "Look at just one group. Count its seeds. A new equal group needs that same number.",
    cues: [
      cue("hint", 0, [
        { type: "highlight", ids: seeds.slice(0, 4).map((seed) => seed.id) },
        { type: "point", id: "group-a", label: "Count this group" },
      ]),
    ],
    question: {
      prompt: "How many seeds are in one group?",
      nodeIds: ["three", "four", "twelve"],
    },
  },
  success: {
    id: "groups-success",
    narration:
      "Exactly. Four more seeds make one more equal group. The groups help us understand the total, without counting everything again.",
    cues: [
      cue("feedback", 0, [
        { type: "highlight", ids: ["four"] },
        { type: "point", id: null },
        { type: "note", text: "One more group means four more seeds." },
      ]),
    ],
  },
};

export const demoLessons: DemoLesson[] = [water, groups];
export const allDemoBeats = demoLessons.flatMap((lesson) => [
  ...lesson.beats,
  lesson.retry,
  lesson.success,
]);
