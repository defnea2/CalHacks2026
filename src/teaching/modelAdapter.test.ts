import { expect, it, vi } from "vitest";
import { createHttpPlanningModel, createStreamingPlanningModel } from "./modelAdapter";
import { TeachingPlanner } from "./TeachingPlanner";
import { emptyCanvas } from "../presentation/contracts";
it("passes the full schema/context and cancellation signal to a server-owned model endpoint", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ id: "test" }) });
  const request = new TeachingPlanner({
    sessionId: "s",
    topic: "Gravity",
  }).request(emptyCanvas());
  const controller = new AbortController();
  expect(
    await createHttpPlanningModel("/api/plan", fetcher)(
      request,
      controller.signal,
    ),
  ).toEqual({ id: "test" });
  expect(fetcher).toHaveBeenCalledWith(
    "/api/plan",
    expect.objectContaining({
      signal: controller.signal,
      method: "POST",
      body: JSON.stringify(request),
    }),
  );
});
it("reports endpoint failures without substituting a scripted lesson", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 503 });
  const request = new TeachingPlanner({
    sessionId: "s",
    topic: "Gravity",
  }).request(emptyCanvas());
  await expect(
    createHttpPlanningModel("/api/plan", fetcher)(request),
  ).rejects.toThrow("HTTP 503");
});
it("waits for a busy model slot and sends the same lesson context once available", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "generated" }) });
    const request = new TeachingPlanner({ sessionId: "s", topic: "Shadows" }).request(emptyCanvas());
    const result = createHttpPlanningModel("/api/plan", fetcher)(request);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toEqual({ id: "generated" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
it("cancels while waiting for a model slot without another request", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const controller = new AbortController();
    const request = new TeachingPlanner({ sessionId: "s", topic: "Shadows" }).request(emptyCanvas());
    const result = createHttpPlanningModel("/api/plan", fetcher)(request, controller.signal);
    const assertion = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it("retries a streaming request that hits a still-busy session slot, and stops when cancelled", async () => {
  vi.useFakeTimers();
  try {
    const request = new TeachingPlanner({ sessionId: "s", topic: "Gravity" }).request(emptyCanvas());
    const ok = { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ id: "later" }) };
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 429 }).mockResolvedValueOnce({ ok: false, status: 429 }).mockResolvedValueOnce(ok);
    const result = createStreamingPlanningModel("/api/plan", fetcher as never)(request);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toEqual({ id: "later" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const busy = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const controller = new AbortController();
    const cancelled = createStreamingPlanningModel("/api/plan", busy as never)(request, controller.signal);
    const assertion = expect(cancelled).rejects.toBeTruthy();
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await assertion;
    expect(busy).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
