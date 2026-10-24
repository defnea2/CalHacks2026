import { expect, it, vi } from "vitest";
import { createHttpPlanningModel } from "./modelAdapter";
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
