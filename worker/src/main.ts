// Worker entry: LLM streaming and tool routing for every active session.
// `pnpm --filter worker start`
import { pack } from '@tutor/shared';
import { Agent } from './agent';
import { loadConfig } from './env';
import { createLessonLlm, createLlm } from './providers';
import { TutorRequests } from './tutorRequests';
import { StdbLink } from './stdb';
import { teachingOutput } from './teachingOutput';

const cfg = loadConfig();
const missing = [
  ['AGENT_SECRET', cfg.agentSecret],
  ...(cfg.llmProvider === 'anthropic'
    ? [['ANTHROPIC_API_KEY', cfg.anthropicApiKey]]
    : [
        ['OPENROUTER_API_KEY', cfg.openrouterApiKey],
        ['OPENROUTER_MODEL', cfg.openrouterModel],
      ]),
].filter(([, v]) => !v);
if (missing.length) {
  console.error(`worker: missing ${missing.map(([k]) => k).join(', ')} (root .env / .env.local; AGENT_SECRET is created by pnpm stdb:publish)`);
  process.exit(1);
}

const ts = () => new Date().toISOString().slice(11, 23);
const log = (m: string) => console.log(`${ts()} ${m}`);

const { llm, info: modelInfo } = createLlm(cfg);
const link = new StdbLink({
  uri: cfg.spacetimeUri,
  db: cfg.spacetimeDb,
  agentSecret: cfg.agentSecret,
  tokenFile: cfg.tokenFile,
  token: process.env.AGENT_TOKEN || undefined,
  log,
});
const agent = new Agent({
  transport: link.transport,
  llm: teachingOutput(llm),
  lessonLlm: createLessonLlm(cfg),
  pack,
  log,
  opts: {
    preemptive: cfg.preemptive,
    preemptiveSilenceMs: cfg.preemptiveSilenceMs,
    maxToolRounds: cfg.maxToolRounds,
    recentTurns: cfg.recentTurns,
    toolTimeoutMs: cfg.toolTimeoutMs,
    replyMode: cfg.replyMode,
  },
});
const tutor = TutorRequests.anthropic(link.transport, cfg.anthropicApiKey, cfg.anthropicModel, log);

log(
  `worker: ${modelInfo}, ` +
    `preemptive ${cfg.preemptive ? `on (${cfg.preemptiveSilenceMs} ms)` : 'off'}, pack ${pack.version}, ${agent.router.tools.length} tools, ` +
    `reply mode ${cfg.replyMode}${cfg.replyMode === 'lesson' ? ` (effort ${cfg.lessonEffort})` : ''}`
);
link.start(agent, tutor);

// agent_status heartbeat (replaces /api/teaching/status).
const heartbeat = setInterval(() => {
  if (!link.transport.conn) return;
  const busy = [...agent.sessions.values()].filter(s => s.live?.open).length;
  link.transport
    .agentHeartbeat({ model: cfg.llmProvider === 'anthropic' ? cfg.anthropicModel : cfg.openrouterModel, provider: cfg.llmProvider, busySessions: busy })
    .catch(e => log(`heartbeat failed: ${e instanceof Error ? e.message : String(e)}`));
}, cfg.heartbeatMs);

const shutdown = () => {
  log('worker: shutting down');
  clearInterval(heartbeat);
  agent.closeAll();
  link.stop();
  setTimeout(() => process.exit(0), 200);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
