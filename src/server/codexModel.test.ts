import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexLaunch } from "./codexModel";

describe("Codex launch", () => {
  const previousPath = process.env.PATH;
  let root: string | undefined;
  afterEach(async () => {
    process.env.PATH = previousPath;
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("runs the native Windows executable behind the npm command shim", async () => {
    if (process.platform !== "win32" || process.arch !== "x64") return;
    root = await mkdtemp(join(tmpdir(), "codex-shim-"));
    const shim = join(root, "codex.cmd");
    const exe = join(root, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    await mkdir(join(exe, ".."), { recursive: true });
    await writeFile(shim, "@echo off\r\n");
    await writeFile(exe, "");
    await writeFile(join(root, "codex"), "#!/bin/sh\n");
    process.env.PATH = root;
    expect(codexLaunch("codex")).toEqual({ command: exe, leadingArgs: [] });
  });
});
