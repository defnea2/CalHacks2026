import { createRef } from "react";
import { fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { NarrationAudio } from "./NarrationAudio";
import { VisualDirector } from "./VisualDirector";

it("drives cues from media events, including pause, without running a separate clock", () => {
  const director = new VisualDirector();
  const token = director.prepare({
    id: "audio",
    narration: "Follow along.",
    cues: [
      {
        id: "note",
        atMs: 1000,
        commands: [{ type: "note", text: "This arrives at one second." }],
      },
    ],
  });
  const audioRef = createRef<HTMLAudioElement>();
  render(
    <NarrationAudio
      director={director}
      token={token}
      src="/demo.wav"
      autoPlay={false}
      audioRef={audioRef}
      onDuration={vi.fn()}
      onError={vi.fn()}
    />,
  );
  const audio = audioRef.current!;
  fireEvent.play(audio);
  expect(director.getSnapshot().status).toBe("ready");
  fireEvent.playing(audio);
  audio.currentTime = 0.5;
  fireEvent.timeUpdate(audio);
  expect(director.getSnapshot().canvas.note).toBe("");
  fireEvent.pause(audio);
  audio.currentTime = 1.5;
  fireEvent.timeUpdate(audio);
  expect(director.getSnapshot().canvas.note).toBe("");
  fireEvent.playing(audio);
  fireEvent.timeUpdate(audio);
  expect(director.getSnapshot().canvas.note).toBe(
    "This arrives at one second.",
  );
  fireEvent.ended(audio);
  expect(director.getSnapshot().status).toBe("completed");
});

it("stops the captured player when the narration component unmounts", () => {
  const director = new VisualDirector();
  const token = director.prepare({
    id: "cleanup",
    narration: "A short line.",
    cues: [],
  });
  const audioRef = createRef<HTMLAudioElement>();
  const { unmount } = render(
    <NarrationAudio
      director={director}
      token={token}
      src="/demo.wav"
      autoPlay={false}
      audioRef={audioRef}
      onDuration={vi.fn()}
      onError={vi.fn()}
    />,
  );
  const player = audioRef.current!;
  Object.defineProperty(player, "paused", { configurable: true, value: false });
  const pause = vi.spyOn(player, "pause").mockImplementation(() => {});
  unmount();
  expect(audioRef.current).toBeNull();
  expect(pause).toHaveBeenCalledOnce();
});
