// Manual integration check: calls the real signed-in model and consumes Codex allowance.
// Run with the dev server already listening: npm run test:live-model
import { createServer } from "vite";
import { writeFile } from "node:fs/promises";
const loader = await createServer({
  configFile: false, server: { middlewareMode: true, hmr: false, watch: null },
  appType: "custom", logLevel: "error",
});
try {
  const { TeachingSession } = await loader.ssrLoadModule("/src/teaching/TeachingSession.ts");
  const { createHttpPlanningModel } = await loader.ssrLoadModule("/src/teaching/modelAdapter.ts");
  const topic = process.argv[2] || "Why does doubling the width of a rectangle double its area?";
  const session = new TeachingSession({ sessionId: crypto.randomUUID(), age: 9, topic }, createHttpPlanningModel("http://127.0.0.1:5173/api/teaching/plan"));
  const started = Date.now();
  if (!await session.plan()) throw new Error(session.getSnapshot().error);
  while (session.planner.getSnapshot().status === "presenting") {
    if (!session.presentNext()) throw new Error(session.getSnapshot().error);
  }
  const first = structuredClone(session.planner.getSnapshot().step);
  console.log(JSON.stringify({ phase: first.phase, beats: first.beats.length, title: session.director.getSnapshot().canvas.title, check: first.check?.kind, elapsedSeconds: Math.round((Date.now()-started)/1000) }));
  const response = first.check?.kind === "choice"
    ? { kind: "choice", optionId: first.check.options.find(o => o.id !== first.check.correctOptionId).id }
    : { kind: "help", request: "simpler" };
  if (!await session.respond(response)) {
    if (process.env.TUTOR_SMOKE_OUTPUT) await writeFile(process.env.TUTOR_SMOKE_OUTPUT, JSON.stringify({ topic, steps: session.planner.getSnapshot().history, canvas: session.director.getSnapshot().canvas, evidence: session.planner.getSnapshot().evidence, error: session.getSnapshot().error }, null, 2));
    throw new Error(session.getSnapshot().error);
  }
  while (session.planner.getSnapshot().status === "presenting") {
    if (!session.presentNext()) throw new Error(session.getSnapshot().error);
  }
  console.log(JSON.stringify({ phase: session.planner.getSnapshot().step.phase, title: session.director.getSnapshot().canvas.title, evidence: session.planner.getSnapshot().evidence.at(-1)?.outcome, elapsedSeconds: Math.round((Date.now()-started)/1000) }));
  if (process.env.TUTOR_SMOKE_OUTPUT) await writeFile(process.env.TUTOR_SMOKE_OUTPUT, JSON.stringify({ topic, steps: session.planner.getSnapshot().history, canvas: session.director.getSnapshot().canvas, evidence: session.planner.getSnapshot().evidence }, null, 2));
  session.cancel();
} finally { await loader.close(); }
