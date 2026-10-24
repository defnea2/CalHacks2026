import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { applyCanvasCommands } from "./canvasState";
import { emptyCanvas } from "./contracts";
import { TeachingCanvas } from "./TeachingCanvas";
const canvas = applyCanvasCommands(emptyCanvas(), [
  {
    type: "add",
    nodes: [
      {
        id: "sun",
        kind: "object",
        x: 200,
        y: 200,
        width: 160,
        height: 160,
        label: "Sun",
        icon: "sun",
      },
    ],
  },
]);
it("renders explanation objects without turning every object into an exercise", () => {
  render(<TeachingCanvas canvas={canvas} />);
  expect(screen.getByRole("group", { name: "Sun" })).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
it("makes only invited objects keyboard-accessible choices", () => {
  const choose = vi.fn();
  render(
    <TeachingCanvas canvas={canvas} choiceIds={["sun"]} onChoose={choose} />,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Sun" }), {
    key: "Enter",
  });
  expect(choose).toHaveBeenCalledWith("sun");
});
