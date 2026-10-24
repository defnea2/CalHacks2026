// Optional macOS authoring utility; the committed audio works on any browser platform.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { allDemoBeats } from "../src/presentation/demo-lessons.ts";
const target = resolve("public/demo-narration");
mkdirSync(target, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "visual-narration-"));
try {
  for (const beat of allDemoBeats) {
    const raw = join(temp, `${beat.id}.aiff`);
    execFileSync("/usr/bin/say", [
      "-v",
      "Samantha",
      "-r",
      "145",
      "-o",
      raw,
      beat.narration,
    ]);
    execFileSync("/usr/bin/afconvert", [
      "-f",
      "WAVE",
      "-d",
      "LEI16@22050",
      raw,
      join(target, `${beat.id}.wav`),
    ]);
    console.log(`Recorded ${beat.id}`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
