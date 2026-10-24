import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { getFixture } from "../shared/fixtures";
import { VisualSandbox } from "./VisualSandbox";

it("rejects invalid JSON without discarding work and preserves placement on a valid update", () => {
  render(<VisualSandbox />);
  fireEvent.click(screen.getByRole("button", { name: "Seed 1" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Place selected object in Garden A" }),
  );
  fireEvent.click(screen.getByText("Configure an activity"));
  fireEvent.change(screen.getByLabelText("Activity JSON"), {
    target: { value: "{broken" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Update current activity" }),
  );
  expect(screen.getByRole("alert")).toBeInTheDocument();
  const activity = getFixture("groups");
  activity.title = "A new challenge";
  fireEvent.change(screen.getByLabelText("Activity JSON"), {
    target: { value: JSON.stringify(activity) },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Update current activity" }),
  );
  expect(
    screen.getByRole("heading", { name: "A new challenge" }),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("region", { name: "Garden A" })).getByRole(
      "button",
      { name: "Seed 1" },
    ),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("loads a new topic through JSON and gives a reset scene a new identity", () => {
  const { container } = render(<VisualSandbox />);
  const oldId = JSON.parse(
    container.querySelector("pre")!.textContent!,
  ).sceneId;
  fireEvent.click(screen.getByText("Configure an activity"));
  const activity = getFixture("water");
  activity.title = "How a plant grows";
  fireEvent.change(screen.getByLabelText("Activity JSON"), {
    target: { value: JSON.stringify(activity) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load as new activity" }));
  expect(
    screen.getByRole("heading", { name: "How a plant grows" }),
  ).toBeInTheDocument();
  const nextId = JSON.parse(
    container.querySelector("pre")!.textContent!,
  ).sceneId;
  expect(nextId).not.toBe(oldId);
});
