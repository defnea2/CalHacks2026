import type { PlanningModel } from "./TeachingPlanner";
import { z } from "zod";
import { readEventStream } from "../shared/eventStream";
import { PlanningProgressSchema } from "./streaming";
import { TeachingStepSchema } from "./contracts";

const BUSY_BACKOFF_MS = [150, 300, 600, 1000, 1000, 1500];
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Cancelled")); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
});

/** Incremental validated beats; no automatic retries after a phrase might have played. */
export function createStreamingPlanningModel(endpoint = "/api/teaching/plan", fetcher: typeof fetch = fetch): PlanningModel {
  return async (request, signal, onProgress) => {
    // Server owns the instructions and schema; avoid resending their ~40 KB browser copies.
    const { systemPrompt: _system, responseSchema: _schema, ...wire } = request;
    // A just-cancelled request can still hold the server's per-session slot (HTTP 429, nothing generated): back off and retry.
    let response!: Response;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      response = await fetcher(endpoint, { method: "POST", signal,
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(wire) });
      if (response.status !== 429 || attempt >= BUSY_BACKOFF_MS.length) break;
      await response.body?.cancel();
      await sleep(BUSY_BACKOFF_MS[attempt], signal);
    }
    if (!response.ok) {
      let detail = "";
      try { const value = await response.json(); if (typeof value.error === "string") detail = value.error.slice(0, 1200); } catch { /* non-JSON proxy */ }
      throw new Error(detail || `Planning endpoint returned HTTP ${response.status}.`);
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream")) return response.json();
    if (!response.body) throw new Error("Planning endpoint returned no stream.");
    for await (const value of readEventStream(response.body, signal)) {
      const event = z.object({ version: z.literal(1), type: z.string(), requestId: z.string().optional(), error: z.string().optional() }).parse(value);
      if (event.type === "error") throw new Error(event.error ?? "Lesson stream failed.");
      if (event.requestId !== request.requestId) throw new Error("Stale planning stream.");
      if (event.type === "complete") return TeachingStepSchema.parse(z.object({ step: z.unknown() }).parse(value).step);
      const { version: _version, requestId: _id, ...progress } = value as Record<string, unknown>;
      onProgress?.(PlanningProgressSchema.parse(progress));
    }
    throw new Error("Lesson stream ended before completion.");
  };
}

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
