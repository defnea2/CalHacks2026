import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SlantLesson } from "./SlantLesson";
import { ShearTutorConversation, type ShearTutorRequest } from "../shearTutor";
import { createShearLesson, reduceShearLesson } from "../../visual-math/shear";

vi.mock("motion/react", async original => ({ ...await original<typeof import("motion/react")>(), useReducedMotion: () => true }));
const reply = (request: ShearTutorRequest) => ({ requestId: request.requestId, revision: request.revision, reply: `Live reply about ${request.lesson.prediction}.`, followUp: "Why?", understanding: "not_yet" });

function playToReveal() {
  fireEvent.click(screen.getByRole("button", { name: /gets bigger/ }));
  const handle = screen.getByRole("slider", { name: "Slant of the top edge" });
  expect(screen.getByRole("button", { name: /Cut along/ })).toBeDisabled();
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(handle).toHaveAttribute("aria-valuenow", "0.5");
  fireEvent.change(screen.getByLabelText("Slant"), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: /Cut along/ }));
  expect(screen.getByLabelText("Slant")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /Slide it/ }));
}

describe("slant lesson", () => {
  it("records a prediction before revealing area, then sends the real learner state to the tutor", async () => {
    const ask = vi.fn(async (request: ShearTutorRequest) => reply(request));
    render(<SlantLesson onExit={() => {}} conversation={new ShearTutorConversation(ask)} />);
    expect(screen.queryByLabelText("Slant")).not.toBeInTheDocument();
    expect(screen.getByRole("img")).not.toHaveAccessibleName(/area/);
    playToReveal();
    expect(await screen.findByText(/Live reply about bigger/)).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAccessibleName(/area 24 square units/);
    expect(document.querySelector("[data-piece=wedge]")).toHaveAttribute("data-offset", "6.000");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toMatchObject({ turn: "reveal", lesson: { prediction: "bigger", base: 6, height: 4, shear: 4, largestShear: 4, adjustments: 2, proofsWatched: 1 } });

    fireEvent.change(screen.getByLabelText("Your thinking"), { target: { value: "The triangle only moved." } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    expect(ask.mock.calls[1][0]).toMatchObject({ turn: "explanation", learnerText: "The triangle only moved." });
    expect(ask.mock.calls[1][0].history.at(-1)).toMatchObject({ role: "tutor" });
  });

  it("labels the scripted fallback when the model is unreachable", async () => {
    render(<SlantLesson onExit={() => {}} conversation={new ShearTutorConversation(async () => { throw new Error("offline"); })} />);
    playToReveal();
    expect(await screen.findByText(/Offline tutor · scripted, not live/)).toBeInTheDocument();
    expect(screen.getByText(/The slanted side did get longer/)).toBeInTheDocument();
  });

  it("drops a tutor reply that arrives after the learner starts a new attempt", async () => {
    let resolve!: (value: unknown) => void;
    const conversation = new ShearTutorConversation(() => new Promise(r => { resolve = r; }));
    render(<SlantLesson onExit={() => {}} conversation={conversation} />);
    playToReveal();
    await screen.findByText(/reading your work/);
    const request = (conversation as unknown as { latest: string }).latest;
    fireEvent.click(screen.getByRole("button", { name: "Try a different slant" }));
    expect(screen.getByLabelText("Slant")).toBeEnabled();
    await act(async () => resolve({ requestId: request, revision: 0, reply: "Stale.", followUp: "?", understanding: "not_yet" }));
    expect(screen.queryByText(/Stale/)).not.toBeInTheDocument();
  });
});

describe("tutor conversation guard", () => {
  it("rejects replies for an older lesson revision even if the request was not cancelled", async () => {
    let lesson = reduceShearLesson(createShearLesson(), { type: "predict", prediction: "same" });
    const conversation = new ShearTutorConversation(async request => { lesson = reduceShearLesson(lesson, { type: "set_shear", shear: 2 }); return reply(request); });
    expect(await conversation.send(lesson, "reveal", null, () => lesson)).toBe(false);
    expect(conversation.getSnapshot().messages).toEqual([]);
  });

  it("rejects a reply whose id does not match the request", async () => {
    const lesson = reduceShearLesson(createShearLesson(), { type: "predict", prediction: "same" });
    const conversation = new ShearTutorConversation(async request => ({ ...reply(request), requestId: "other" }));
    await conversation.send(lesson, "reveal", null, () => lesson);
    expect(conversation.getSnapshot().messages[0].source).toBe("offline");
  });
});
