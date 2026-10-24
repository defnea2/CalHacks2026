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
