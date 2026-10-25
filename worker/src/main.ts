// Worker entry: LLM streaming and tool routing for every active session.
// `pnpm --filter worker start`
import { pack } from '@tutor/shared';
import { Agent } from './agent';
import { loadConfig } from './env';
import { createLlm } from './providers';
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
  pack,
  log,
  opts: {
    preemptive: cfg.preemptive,
    preemptiveSilenceMs: cfg.preemptiveSilenceMs,
    maxToolRounds: cfg.maxToolRounds,
    recentTurns: cfg.recentTurns,
    toolTimeoutMs: cfg.toolTimeoutMs,
  },
});

log(
  `worker: ${modelInfo}, ` +
    `preemptive ${cfg.preemptive ? `on (${cfg.preemptiveSilenceMs} ms)` : 'off'}, pack ${pack.version}, ${agent.router.tools.length} tools`
);
link.start(agent);

const shutdown = () => {
  log('worker: shutting down');
  agent.closeAll();
  link.stop();
  setTimeout(() => process.exit(0), 200);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
