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
    if (!response.ok) {
      let detail = "";
      try {
        const body: unknown = await response.json();
        if (body && typeof body === "object" && "error" in body && typeof body.error === "string") detail = body.error.slice(0, 1200);
      } catch { /* Proxies may return non-JSON errors. */ }
      throw new Error(detail ||
        "Planning endpoint returned HTTP " +
          response.status +
          ". Keep the current step and retry.");
    }
    const result: unknown = await response.json();
    // Shape validation, mathematical preflight, and evidence policy happen in planner.accept.
    return result;
  };
}
