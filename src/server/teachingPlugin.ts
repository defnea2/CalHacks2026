import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { z } from "zod";
import { createCodexGenerator, DEFAULT_TUTOR_MODEL, type CodexOptions } from "./codexModel";
import { generatePlan, parseModelRequest, type GenerateCandidate } from "./planning";
import { createAnthropicPlanner, DEFAULT_ANTHROPIC_MODEL, type AnthropicOptions } from "./anthropicModel";
import type { PlanningProgressHandler } from "../teaching/streaming";
import { createShearTutor } from "./shearTutor";

function reply(res: ServerResponse, status: number, body: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}
export function trustedRequest(req: IncomingMessage, port: number) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  return hosts.includes(req.headers.host ?? "") && (!req.headers.origin || hosts.some(h => req.headers.origin === `http://${h}`));
}
export async function readJson(req: IncomingMessage, signal: AbortSignal) {
  signal.throwIfAborted();
  const cancel = () => req.destroy(new Error("Request cancelled."));
  signal.addEventListener("abort", cancel, { once: true });
  try {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 1_000_000) throw new Error("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { signal.removeEventListener("abort", cancel); }
}
export interface TeachingOptions extends CodexOptions, AnthropicOptions { provider?: "anthropic" | "codex" }
export function teachingPlugin(options: TeachingOptions = {}, generate?: GenerateCandidate): Plugin {
  const provider = options.provider ?? "anthropic";
  const legacy = generate ?? (provider === "codex" ? createCodexGenerator(options) : undefined);
  const anthropic = createAnthropicPlanner(options);
  const shearTutor = createShearTutor(options);
  let shearActive = 0;
  const STREAM_DEADLINE_MS = 15_000;
  const active = new Map<string, AbortController>();
  return {
    name: "local-teaching-model", apply: "serve",
    configureServer(server) {
      server.httpServer?.once("close", () => active.forEach(controller => controller.abort()));
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/teaching/plan" && req.url !== "/api/teaching/status" && req.url !== "/api/teaching/shear-feedback") return next();
        const address = server.httpServer?.address();
        const port = address && typeof address !== "string" ? address.port : server.config.server.port;
        if (!port || !trustedRequest(req, port)) return reply(res, 403, { error: "This model bridge accepts requests only from its local app." });
        if (req.url === "/api/teaching/status" && req.method === "GET")
          return reply(res, 200, { provider, mode: provider === "codex" ? "chatgpt-login" : "api", model: options.model ?? (provider === "codex" ? DEFAULT_TUTOR_MODEL : DEFAULT_ANTHROPIC_MODEL), busy: active.size > 0, configured: provider === "codex" || Boolean(options.apiKey), streaming: provider === "anthropic" });
        if (req.method !== "POST") return reply(res, 405, { error: "Use POST for lesson planning." });
        if (!req.headers["content-type"]?.startsWith("application/json")) return reply(res, 415, { error: "Send application/json." });
        if (req.url === "/api/teaching/shear-feedback") {
          if (provider !== "anthropic") return reply(res, 501, { error: "Live slant feedback uses the Anthropic provider." });
          if (shearActive >= 4) return reply(res, 429, { error: "The tutor is busy. Retry shortly." });
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error("Tutor reply timed out.")), 30_000);
          const disconnected = () => { if (!res.writableEnded) controller.abort(new Error("Request cancelled.")); };
          res.once("close", disconnected);
          shearActive++;
          try {
            let body;
            try { body = await readJson(req, controller.signal); } catch { return reply(res, 400, { error: "Invalid or oversized JSON request." }); }
            reply(res, 200, await shearTutor(body, controller.signal));
          } catch (error) {
            reply(res, error instanceof z.ZodError ? 400 : controller.signal.aborted ? 504 : 502, { error: error instanceof z.ZodError ? "Invalid slant lesson state." : error instanceof Error ? error.message : "Tutor reply failed." });
          } finally { shearActive--; clearTimeout(timer); res.removeListener("close", disconnected); }
          return;
        }
        const controller = new AbortController();
        let timer = setTimeout(() => controller.abort(new Error("Lesson planning timed out. Try a shorter question.")), provider === "codex" ? 120_000 : 45_000);
        let sessionId: string | undefined;
        const release = () => { if (sessionId && active.get(sessionId) === controller) active.delete(sessionId); };
        // Free the session slot the moment the client goes away; the next request must not wait for the provider to unwind.
        const disconnected = () => { if (!res.writableEnded) { controller.abort(new Error("Request cancelled.")); release(); } };
        res.once("close", disconnected);
        try {
          let request;
          try { request = parseModelRequest(await readJson(req, controller.signal)); }
          catch (error) {
            return reply(res, 400, { error: error instanceof z.ZodError ? "Invalid lesson context. Refresh and start a new lesson." : "Invalid or oversized JSON request." });
          }
          const id = request.context.session.sessionId;
          if (active.get(id)?.signal.aborted) active.delete(id);
          if (active.has(id) || active.size >= (legacy ? 1 : 4)) return reply(res, 429, { error: "A lesson is already being planned. Cancel it or retry shortly." });
          sessionId = id;
          active.set(id, controller);
          const streaming = req.headers.accept?.includes("text/event-stream");
          const started = performance.now();
          let firstBeatMs: number | null = null;
          const send = (event: unknown) => {
            if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
          };
          if (streaming) {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
            res.flushHeaders();
          }
          const progress: PlanningProgressHandler = event => {
            controller.signal.throwIfAborted();
            if (event.type === "beat" && firstBeatMs === null) {
              firstBeatMs = Math.round(performance.now() - started);
              // Once speech has started, a stalled provider means dead air: fail fast instead of waiting out the full timeout.
              clearTimeout(timer);
              timer = setTimeout(() => controller.abort(new Error("The lesson stopped responding. Try again.")), STREAM_DEADLINE_MS);
            }
            if (streaming) send({ version: 1, requestId: request.requestId, ...event });
          };
          const step = legacy
            ? await generatePlan(request, legacy, controller.signal)
            : await anthropic(request, controller.signal, progress);
          if (streaming) {
            send({ version: 1, requestId: request.requestId, type: "complete", step, metrics: { firstBeatMs, totalMs: Math.round(performance.now() - started) } });
            res.end();
          } else reply(res, 200, step);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Lesson planning failed.";
          if (res.headersSent) {
            if (!res.destroyed && !res.writableEnded) res.end(`data: ${JSON.stringify({ version: 1, type: "error", error: message })}\n\n`);
          } else reply(res, controller.signal.aborted ? 504 : 502, { error: message });
        } finally {
          clearTimeout(timer);
          res.removeListener("close", disconnected);
          release();
        }
      });
    },
  };
}
