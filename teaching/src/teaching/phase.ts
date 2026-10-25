import { z } from "zod";

// Own file so arc.ts (imported by contracts.ts for SessionConfig.arc) can use it without a cycle.
export const PhaseSchema = z.enum([
  "diagnose",
  "intuition",
  "formalize",
  "worked_example",
  "repair",
  "solo",
  "transfer",
  "return_to_problem",
]);
export type TeachingPhase = z.infer<typeof PhaseSchema>;
