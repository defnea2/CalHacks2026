import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VisualDirector } from "../VisualDirector";
import { MathWorkbench } from "./MathWorkbench";
import {
  arrayRehearsal,
  barRehearsal,
  numberLineRehearsal,
  activityRehearsal,
} from "./rehearsals";
import { fixtureKeys } from "../../shared/fixtures";

describe("voice-free rehearsal", () => {
  it("runs every example through the public director interface", () => {
    for (const steps of [
      arrayRehearsal(),
      arrayRehearsal(5, 17, 8),
      numberLineRehearsal(),
      barRehearsal(),
      ...fixtureKeys.map(activityRehearsal),
    ]) {
      const d = new VisualDirector();
      for (const step of steps) {
        const token = d.prepare(step.beat);
        d.narrationStarted(token);
        d.narrationEnded(token);
        expect(d.getSnapshot().status).toBe("completed");
      }
    }
  });
  it("builds a changing diagram and captures a learner action with no voice service", () => {
    render(<MathWorkbench />);
    fireEvent.click(
      screen.getByRole("button", { name: "Build the first visual" }),
    );
    for (let i = 0; i < 5; i++)
      fireEvent.click(
        screen.getByRole("button", { name: "Next teaching step" }),
      );
    expect(
      screen.getByLabelText("Linked mathematical statement"),
    ).toHaveTextContent("40 + 16 = 56");
    fireEvent.change(screen.getByRole("slider", { name: "Number of groups" }), {
      target: { value: "5" },
    });
    expect(
      screen.getByLabelText("Linked mathematical statement"),
    ).toHaveTextContent("50 + 20 = 70");
    expect(screen.getByLabelText("Learner event log")).toHaveTextContent(
      "math_changed",
    );
  });
  it("keeps the active drawing when JSON is invalid, and waits for simulated playback", () => {
    render(<MathWorkbench />);
    fireEvent.click(
      screen.getByRole("button", { name: "Build the first visual" }),
    );
    fireEvent.change(screen.getByLabelText("Visual step JSON"), {
      target: { value: '{"broken":true}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare JSON step" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "3 rows of 14, 42 cells" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Visual step JSON"), {
      target: { value: JSON.stringify(arrayRehearsal()[1].beat) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare JSON step" }));
    expect(
      screen.getByRole("img", { name: "3 rows of 14, 42 cells" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start / resume" }));
    expect(
      screen.getByRole("img", {
        name: "3 rows of 14, 42 cells, split into 10 and 4",
      }),
    ).toBeInTheDocument();
  });
  it("applies valid custom quantities and rejects an out-of-range split", () => {
    render(<MathWorkbench />);
    fireEvent.change(screen.getByLabelText("Starting groups"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText("In each group"), {
      target: { value: "17" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use these numbers" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Build the first visual" }),
    );
    expect(
      screen.getByRole("img", { name: "5 rows of 17, 85 cells" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Split after"), {
      target: { value: "18" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use these numbers" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "split inside the group",
    );
    expect(
      screen.getByRole("img", { name: "5 rows of 17, 85 cells" }),
    ).toBeInTheDocument();
  });
});

it("applies live tutor commands and generates the next example from learner edits", () => {
  render(<MathWorkbench />);
  fireEvent.click(
    screen.getByRole("button", { name: "Build the first visual" }),
  );
  fireEvent.change(screen.getByLabelText("Live groups"), {
    target: { value: "5" },
  });
  expect(
    screen.getByRole("img", { name: "5 rows of 14, 70 cells" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Next teaching step" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(
      "Here are 3 groups of 14. We can make this easier to count.",
    ),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Show mathematical statement"));
  fireEvent.click(screen.getByLabelText("Let the learner manipulate"));
  fireEvent.change(screen.getByRole("slider", { name: "Number of groups" }), {
    target: { value: "7" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Different numbers" }));
  expect(
    screen.getByLabelText("Linked mathematical statement"),
  ).toHaveTextContent("7 × 15 = 105");
  fireEvent.click(screen.getByRole("button", { name: "Simpler example" }));
  expect(
    screen.getByLabelText("Linked mathematical statement"),
  ).toHaveTextContent("4 × 8 = 32");
});

it("clears incompatible focus when shrinking a split array and preserves the scene on invalid input", () => {
  render(<MathWorkbench />);
  fireEvent.click(
    screen.getByRole("button", { name: "Build the first visual" }),
  );
  fireEvent.click(screen.getByLabelText("Split into parts"));
  fireEvent.change(screen.getByLabelText("Visual focus"), {
    target: { value: "left" },
  });
  fireEvent.change(screen.getByLabelText("Live objects per group"), {
    target: { value: "1" },
  });
  expect(
    screen.getByRole("img", { name: "3 rows of 1, 3 cells" }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Live groups"), {
    target: { value: "13" },
  });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: "3 rows of 1, 3 cells" }),
  ).toBeInTheDocument();
});

it("configures bar quantities and changes a number-line scale atomically", () => {
  render(<MathWorkbench />);
  fireEvent.change(screen.getByLabelText("Math rehearsal"), {
    target: { value: "bars" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Build the first visual" }),
  );
  fireEvent.change(screen.getByLabelText("Second whole live shaded"), {
    target: { value: "2" },
  });
  fireEvent.click(screen.getByLabelText("Show mathematical statement"));
  expect(
    screen.getByLabelText("Linked mathematical statement"),
  ).toHaveTextContent("1/2 = 2/4");
  expect(
    screen.queryByRole("button", { name: /Compare coloured/ }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Math rehearsal"), {
    target: { value: "number_line" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Build the first visual" }),
  );
  fireEvent.change(screen.getByLabelText("Scale maximum"), {
    target: { value: "0.2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply scale" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Marker outside number line range",
  );
  expect(
    screen.getByRole("slider", { name: "Move First number" }),
  ).toHaveAttribute("aria-valuemax", "1");
  fireEvent.change(screen.getByLabelText("Scale maximum"), {
    target: { value: "2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply scale" }));
  expect(
    screen.getByRole("slider", { name: "Move First number" }),
  ).toHaveAttribute("aria-valuemax", "2");
});
