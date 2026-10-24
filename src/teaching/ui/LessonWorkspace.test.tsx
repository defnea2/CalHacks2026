import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LessonWorkspace } from "./LessonWorkspace";
import App from "../../app/App";

beforeEach(() => vi.spyOn(window, "scrollTo").mockImplementation(() => {}));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("integrated lesson experience", () => {
  it("turns an answer into the next visual and changes representation without manual planning", async () => {
    render(<LessonWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: /Equal groups/ }));
    await screen.findByRole("button", { name: /2 \+ 3/ });
    fireEvent.click(screen.getByRole("button", { name: /2 \+ 3/ }));
    await screen.findByLabelText("Your thinking");
    expect(screen.getByRole("img", { name: "2 rows of 3, 6 cells" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show another way" }));
    await screen.findByRole("heading", { name: "Move the apples into baskets" });
    fireEvent.change(screen.getByLabelText("Your thinking"), { target: { value: "six" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await screen.findByLabelText("Linked mathematical statement");
    expect(screen.getByLabelText("Linked mathematical statement")).toHaveTextContent("2 × 3 = 6");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("What is 7 × 8?")).toBeInTheDocument();
  });
  it("keeps the lesson when inspecting development tools", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Equal groups/ }));
    await screen.findByRole("button", { name: /2 \+ 3/ });
    fireEvent.click(screen.getByRole("button", { name: "Development tools" }));
    expect(screen.queryByRole("button", { name: /2 \+ 3/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to my lesson" }));
    expect(screen.getByRole("button", { name: /2 \+ 3/ })).toBeInTheDocument();
  });
  it("shows a model error without silently substituting a sample and lets the learner leave", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    render(<LessonWorkspace />);
    fireEvent.change(screen.getByLabelText("What would you like to understand?"), { target: { value: "How do shadows work?" } });
    fireEvent.click(screen.getByRole("button", { name: /Explore my question/ }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /rows of/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "← All topics" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /What are you.*wondering about\?/ })).toBeInTheDocument());
  });
});
