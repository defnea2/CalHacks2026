import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outputSchema = {
  type: "object", properties: { step_json: { type: "string" } },
  required: ["step_json"], additionalProperties: false,
};
export interface CodexOptions { binary?: string; model?: string }
export function codexArgs(dir: string, model?: string) {
  return [
    "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
    "--sandbox", "read-only", "--cd", dir, "--color", "never",
    "--output-schema", join(dir, "response-schema.json"),
    "--output-last-message", join(dir, "response.json"),
    "-c", 'approval_policy="never"', "-c", 'forced_login_method="chatgpt"', "-c", 'web_search="disabled"',
    "-c", "project_doc_max_bytes=0", "-c", 'model_reasoning_effort="low"',
    ...["shell_tool", "apps", "plugins", "remote_plugin", "multi_agent", "computer_use", "browser_use", "in_app_browser", "image_generation", "code_mode_host", "hooks", "goals", "skill_search"].flatMap(feature => ["--disable", feature]),
    ...(model ? ["--model", model] : []), "-",
  ];
}
function childEnvironment() {
  // Keep normal CLI login lookup. Never read, copy, or send its credential files ourselves.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "USER", "LOGNAME", "SYSTEMROOT"])
    if (process.env[key]) env[key] = process.env[key];
  return env;
}
async function run(binary: string, args: string[], input: string, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "ignore", "pipe"], env: childEnvironment() });
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
