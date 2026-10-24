import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { demoLessons, allDemoBeats } from "./demo-lessons";
import { VisualDirector } from "./VisualDirector";

it.each(demoLessons)(
  "rehearses $id from explanation through a hint and successful response",
  (lesson) => {
    const d = new VisualDirector();
    for (const beat of lesson.beats) {
      const token = d.prepare(beat);
      d.narrationStarted(token);
      for (const cue of beat.cues) d.narrationProgress(token, cue.atMs);
      d.narrationEnded(token);
      expect(d.getSnapshot().error).toBeNull();
    }
    expect(d.getSnapshot().status).toBe("awaiting_answer");
    const wrong = lesson.beats
      .at(-1)!
      .question!.nodeIds.find((id) => id !== lesson.answerId)!;
    expect(d.respond(wrong)?.nodeId).toBe(wrong);
    const retry = d.prepare(lesson.retry);
    d.narrationStarted(retry);
    d.narrationEnded(retry);
    expect(d.getSnapshot().status).toBe("awaiting_answer");
    expect(d.respond(lesson.answerId)?.nodeId).toBe(lesson.answerId);
    const success = d.prepare(lesson.success);
    d.narrationStarted(success);
    d.narrationEnded(success);
    expect(d.getSnapshot().status).toBe("completed");
    expect(d.getSnapshot().canvas.nodes.length).toBeGreaterThan(0);
  },
);
it("ships a playable PCM recording long enough for every demo cue", () => {
  for (const beat of allDemoBeats) {
    const wav = readFileSync(`public/demo-narration/${beat.id}.wav`);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    let byteRate = 0,
      dataSize = 0;
    for (let at = 12; at + 8 <= wav.length; ) {
      const tag = wav.toString("ascii", at, at + 4),
        size = wav.readUInt32LE(at + 4);
      if (tag === "fmt ") byteRate = wav.readUInt32LE(at + 16);
      if (tag === "data") dataSize = size;
      at += 8 + size + (size % 2);
    }
    expect(byteRate).toBeGreaterThan(0);
    expect((dataSize / byteRate) * 1000).toBeGreaterThan(
      beat.cues.at(-1)!.atMs,
    );
  }
});
