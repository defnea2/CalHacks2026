import type { Evidence, SessionConfig, TeachingPhase, TeachingStep } from "./contracts";
import { arcPhases } from "./arc";

export function allowedPhases(
  current: TeachingStep | null,
  evidence: Evidence | undefined,
  config?: Pick<SessionConfig, "lessonStyle" | "arc" | "decision">,
): TeachingPhase[] {
  // A rigid arc (lesson pack) replaces the adaptive policy below.
  if (config?.arc) return arcPhases(config.arc, current, evidence, config.decision);
  if (!current) return config?.lessonStyle === "mini_lesson" ? ["intuition"] : ["diagnose"];
  if (
    config?.lessonStyle === "mini_lesson" &&
    evidence?.response.kind === "help" &&
    ["explain", "simpler", "another_way"].includes(evidence.response.request)
  ) return ["intuition", "repair"];
  if (evidence?.response.kind === "help")
    return current.phase === "return_to_problem"
      ? ["diagnose", "intuition"]
      : [current.phase, "intuition"];
  if (current.check && !evidence) return [current.phase];
  if (evidence?.outcome === "unclear") return [current.phase];
  if (evidence?.outcome === "incorrect")
    return current.phase === "diagnose"
      ? ["diagnose", "intuition"]
      : ["intuition", "worked_example", "repair"];
  switch (current.phase) {
    case "diagnose":
      return ["intuition", "formalize", "worked_example", "solo"];
    case "intuition":
      return ["intuition", "formalize", "worked_example", "solo"];
    case "formalize":
      return ["worked_example", "repair", "solo"];
    case "worked_example":
      return ["repair", "solo"];
    case "repair":
      return ["intuition", "worked_example", "solo"];
    case "solo":
      return ["transfer", "return_to_problem"];
    case "transfer":
      return ["return_to_problem", "solo"];
    case "return_to_problem":
      return [];
  }
}
