import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { z } from "zod";
import { createCodexGenerator, DEFAULT_TUTOR_MODEL, type CodexOptions } from "./codexModel";
import { generatePlan, parseModelRequest, type GenerateCandidate } from "./planning";

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
export function teachingPlugin(options: CodexOptions = {}, generate: GenerateCandidate = createCodexGenerator(options)): Plugin {
  let active = false;
  let current: AbortController | null = null;
  return {
    name: "local-teaching-model", apply: "serve",
    configureServer(server) {
      server.httpServer?.once("close", () => current?.abort());
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/teaching/plan" && req.url !== "/api/teaching/status") return next();
        const address = server.httpServer?.address();
        const port = address && typeof address !== "string" ? address.port : server.config.server.port;
        if (!port || !trustedRequest(req, port)) return reply(res, 403, { error: "This model bridge accepts requests only from its local app." });
        if (req.url === "/api/teaching/status" && req.method === "GET")
          return reply(res, 200, { provider: "codex", mode: "chatgpt-login", model: options.model ?? DEFAULT_TUTOR_MODEL, busy: active, configured: true });
        if (req.method !== "POST") return reply(res, 405, { error: "Use POST for lesson planning." });
        if (!req.headers["content-type"]?.startsWith("application/json")) return reply(res, 415, { error: "Send application/json." });
        if (active) return reply(res, 429, { error: "Another lesson is being planned. Wait for it to finish, then retry." });
        active = true;
        const controller = new AbortController();
        current = controller;
        const timer = setTimeout(() => controller.abort(new Error("Lesson planning timed out. Try a shorter question.")), 120_000);
        const disconnected = () => { if (!res.writableEnded) controller.abort(new Error("Request cancelled.")); };
        res.once("close", disconnected);
        try {
          let request;
          try { request = parseModelRequest(await readJson(req, controller.signal)); }
          catch (error) {
            return reply(res, 400, { error: error instanceof z.ZodError ? "Invalid lesson context. Refresh and start a new lesson." : "Invalid or oversized JSON request." });
          }
          const step = await generatePlan(request, generate, controller.signal);
          reply(res, 200, step);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Lesson planning failed.";
          reply(res, controller.signal.aborted ? 504 : 502, { error: message });
        } finally {
          clearTimeout(timer);
          res.removeListener("close", disconnected);
          current = null;
          active = false;
        }
      });
    },
  };
}
