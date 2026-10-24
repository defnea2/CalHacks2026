import type { PlanningModel } from "./TeachingPlanner";

/** Call a host-owned server endpoint. Provider credentials never enter this module/browser. */
export function createHttpPlanningModel(
  endpoint = "/api/teaching/plan",
  fetcher: typeof fetch = fetch,
): PlanningModel {
  return async (request, signal) => {
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      response = await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
      });
      if (response.status !== 429 || attempt >= 12) break;
      // A busy local slot has not generated anything. Wait without duplicating model work.
      await response.body?.cancel();
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Cancelled")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 3000);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
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
