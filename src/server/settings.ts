import type { TeachingOptions } from "./teachingPlugin";

/** Server-only env values. Never use a VITE_ prefix for provider credentials. */
export function teachingOptions(env: Record<string, string | undefined>): TeachingOptions {
  const provider = env.TUTOR_PROVIDER ?? "anthropic";
  if (provider !== "anthropic" && provider !== "codex") throw new Error("TUTOR_PROVIDER must be anthropic or codex.");
  const effort = env.TUTOR_ANTHROPIC_EFFORT ?? "low";
  if (!["low", "medium", "high"].includes(effort)) throw new Error("TUTOR_ANTHROPIC_EFFORT must be low, medium or high.");
  return { provider, apiKey: env.ANTHROPIC_API_KEY, binary: env.TUTOR_CODEX_BIN, effort: effort as TeachingOptions["effort"],
    model: provider === "anthropic" ? env.TUTOR_ANTHROPIC_MODEL : env.TUTOR_CODEX_MODEL };
}
