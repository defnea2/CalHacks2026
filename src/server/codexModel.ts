import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const outputSchema = {
  type: "object", properties: { step_json: { type: "string" } },
  required: ["step_json"], additionalProperties: false,
};
export const DEFAULT_TUTOR_MODEL = "gpt-5.6-luna";
export interface CodexOptions { binary?: string; model?: string }
export function codexArgs(dir: string, model = DEFAULT_TUTOR_MODEL) {
  return [
    "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
    "--sandbox", "read-only", "--cd", dir, "--color", "never",
    "--output-schema", join(dir, "response-schema.json"),
    "--output-last-message", join(dir, "response.json"),
    "-c", 'approval_policy="never"', "-c", 'forced_login_method="chatgpt"', "-c", 'web_search="disabled"',
    "-c", "project_doc_max_bytes=0", "-c", 'model_reasoning_effort="low"',
    ...["shell_tool", "apps", "plugins", "remote_plugin", "multi_agent", "computer_use", "browser_use", "in_app_browser", "image_generation", "code_mode_host", "hooks", "goals", "skill_search"].flatMap(feature => ["--disable", feature]),
    "--model", model, "-",
  ];
}
function childEnvironment() {
  // Keep normal CLI login lookup. Never read, copy, or send its credential files ourselves.
  const keys = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "USER", "LOGNAME", "SYSTEMROOT"];
  if (process.platform === "win32") keys.push("USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "USERNAME");
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) if (process.env[key]) env[key] = process.env[key];
  return env;
}
function windowsCodexPackage() {
  if (process.arch === "arm64") return { name: "codex-win32-arm64", triple: "aarch64-pc-windows-msvc" };
  if (process.arch === "x64") return { name: "codex-win32-x64", triple: "x86_64-pc-windows-msvc" };
  return undefined;
}
function codexCandidates(binary: string) {
  const explicit = /[\\/]/.test(binary) || /^[A-Za-z]:/.test(binary);
  if (explicit) return binary.toLowerCase().endsWith(".cmd") ? [binary] : [binary, `${binary}.cmd`];
  const names = [binary, `${binary}.exe`, `${binary}.cmd`, `${binary}.bat`];
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap(dir => names.map(name => join(dir, name)));
}
/** npm installs `codex` as a `.cmd` shim. Node's spawn does not run that shim, so use the native executable it would launch. */
export function codexLaunch(binary: string) {
  if (process.platform !== "win32") return { command: binary, leadingArgs: [] as string[] };
  const pkg = windowsCodexPackage();
  for (const candidate of codexCandidates(binary)) {
    if (!existsSync(candidate)) continue;
    const lower = candidate.toLowerCase();
    if (lower.endsWith(".exe")) return { command: candidate, leadingArgs: [] as string[] };
    if (lower.endsWith(".js")) return { command: process.execPath, leadingArgs: [candidate] };
    if (!lower.endsWith(".cmd") && !lower.endsWith(".bat")) continue;
    const root = join(dirname(candidate), "node_modules", "@openai", "codex");
    const exe = pkg && join(root, "node_modules", "@openai", pkg.name, "vendor", pkg.triple, "bin", "codex.exe");
    if (exe && existsSync(exe)) return { command: exe, leadingArgs: [] as string[] };
    const script = join(root, "bin", "codex.js");
    if (existsSync(script)) return { command: process.execPath, leadingArgs: [script] };
  }
  return { command: binary, leadingArgs: [] as string[] };
}
async function run(binary: string, args: string[], input: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const launch = codexLaunch(binary);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.command, [...launch.leadingArgs, ...args], { stdio: ["pipe", "ignore", "pipe"], env: childEnvironment(), windowsHide: true });
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
    child.stdin.on("error", () => {}); // A failed spawn can close stdin before its error event.
    child.once("error", () => {
      signal.removeEventListener("abort", cancel);
      if (killTimer) clearTimeout(killTimer);
      reject(new Error("Codex CLI could not start. Install Codex and run codex login on this machine."));
    });
    child.once("close", code => {
      signal.removeEventListener("abort", cancel);
      if (killTimer) clearTimeout(killTimer);
      if (signal.aborted) return reject(signal.reason);
      if (code === 0) return resolve();
      // Do not forward raw CLI diagnostics: they can contain local paths or account details.
      if (/rate.limit|usage.limit|quota/i.test(stderr)) reject(new Error("Your Codex allowance is currently unavailable. Check Codex usage and try again later."));
      else if (/unauthorized|not.logged|401|auth|login/i.test(stderr)) reject(new Error("Codex needs a working ChatGPT login. Run codex login in your terminal, then retry."));
      else reject(new Error("The local Codex request failed. Check your connection and Codex model access, then retry."));
    });
    child.stdin.end(input);
  });
}
export function createCodexGenerator(options: CodexOptions = {}) {
  return async (prompt: string, signal: AbortSignal): Promise<unknown> => {
    const dir = await mkdtemp(join(tmpdir(), "tutor-plan-"));
    try {
      await writeFile(join(dir, "response-schema.json"), JSON.stringify(outputSchema), { mode: 0o600 });
      await run(options.binary ?? "codex", codexArgs(dir, options.model), prompt, signal);
      const envelope = JSON.parse(await readFile(join(dir, "response.json"), "utf8")) as { step_json?: unknown };
      if (typeof envelope.step_json !== "string") throw new Error("The model returned an unreadable lesson. Try again.");
      return JSON.parse(envelope.step_json);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
