// Live latency check against the dev server (npm run dev). Consumes provider allowance.
// Usage: [RETEACH=1] node scripts/latency.mjs ["topic" ...]   RETEACH=1 also sends a wrong-answer/another_way follow-up and prints the visual kinds of both lessons   (defaults to three fraction/multiplication/decimal topics)
import { createServer } from "vite";
const topics = process.argv.length > 2 ? process.argv.slice(2) : ["Why is 1/2 the same as 2/4?", "Why does 3 x 4 equal 4 x 3?", "Why is 0.5 bigger than 0.25?"];
const url = process.env.TUTOR_URL || "http://127.0.0.1:5173/api/teaching/plan";
const loader = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "error" });
try {
  const { TeachingPlanner } = await loader.ssrLoadModule("/src/teaching/TeachingPlanner.ts");
  const { emptyCanvas } = await loader.ssrLoadModule("/src/presentation/contracts.ts");
  const run = async (request, topic) => {
    const t0 = performance.now(), r = { topic, firstEventMs: null, firstBeatMs: null, totalMs: null, beats: 0, moments: 0, events: [], error: null }, out = { r, step: null };
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(request) });
    if (!res.ok) { r.error = `HTTP ${res.status} ${(await res.text()).slice(0, 300)}`; return out; }
    let buf = "";
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString("utf8");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).replace(/^data: /, ""); buf = buf.slice(i + 2);
        if (!line.trim()) continue;
        const e = JSON.parse(line), ms = Math.round(performance.now() - t0);
        r.firstEventMs ??= ms; r.events.push(`${e.type}@${ms}`);
        if (e.type === "beat") { r.beats++; r.firstBeatMs ??= ms; }
        if (e.type === "complete") { r.totalMs = ms; r.moments = e.step.beats.length; r.phase = e.step.phase; out.step = e.step; }
        if (e.type === "error") r.error = e.error;
      }
    }
    r.events = r.events.length > 14 ? [...r.events.slice(0, 6), "...", ...r.events.slice(-2)] : r.events;
    return out;
  };
  const kinds = step => step.beats.flatMap(b => b.cues.flatMap(c => c.commands)).filter(c => c.type === "show_math").map(c => c.visual.kind).join(",");
  for (const topic of topics) {
    const planner = new TeachingPlanner({ sessionId: crypto.randomUUID(), age: 9, topic, lessonStyle: "mini_lesson" });
    const req1 = planner.request(emptyCanvas());
    const { r, step } = await run(req1, topic);
    if (step) r.visuals = kinds(step);
    console.log(JSON.stringify(r));
    if (!process.env.RETEACH || !step) continue;
    // Replay the lesson onto a canvas, then answer wrongly / ask for another way and plan again.
    const { applyCanvasCommands } = await loader.ssrLoadModule("/src/presentation/canvasState.ts");
    let canvas = emptyCanvas();
    for (const b of step.beats) for (const c of b.cues) canvas = applyCanvasCommands(canvas, c.commands);
    planner.accept(req1.requestId, step, emptyCanvas()); planner.presented(step.id);
    const response = process.env.RETEACH === "help" ? { kind: "help", request: "another_way" }
      : step.check?.kind === "choice" ? { kind: "choice", optionId: step.check.options.find(o => o.id !== step.check.correctOptionId).id }
      : step.check?.kind === "number" ? { kind: "answer", text: "999" } : { kind: "help", request: "another_way" };
    planner.respond({ eventId: crypto.randomUUID(), stepId: step.id, response }, canvas);
    const second = await run(planner.request(canvas), topic + " (reteach)");
    if (second.step) second.r.visuals = kinds(second.step), second.r.check = second.step.check?.kind, second.r.phase = second.step.phase;
    console.log(JSON.stringify(second.r));
  }
} finally { await loader.close(); }
