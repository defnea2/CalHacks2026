import type { PlanningModel } from "./TeachingPlanner";

/** Call a host-owned server endpoint. Provider credentials never enter this module/browser. */
export function createHttpPlanningModel(
  endpoint = "/api/teaching/plan",
  fetcher: typeof fetch = fetch,
): PlanningModel {
  return async (request, signal) => {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok)
      throw new Error(
        "Planning endpoint returned HTTP " +
          response.status +
          ". Keep the current step and retry.",
      );
    const result: unknown = await response.json();
    // Shape validation, mathematical preflight, and evidence policy happen in planner.accept.
    return result;
  };
}
