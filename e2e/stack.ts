// Brings the isolated E2E stack up and keeps it running until Ctrl-C (for debugging scenarios
// by hand: open the printed URL). `pnpm --filter e2e stack`
import { E2E_DEFAULTS } from './scenarios';
import { freePort, up } from './lib/stack';

const stack = await up({
  db: E2E_DEFAULTS.db,
  clientPort: await freePort(E2E_DEFAULTS.clientPort),
  moduleEnv: E2E_DEFAULTS.moduleEnv,
  log: m => console.log(m),
});
console.log(`stack up: ${stack.clientUrl}?db=${stack.db}`);
const stop = async () => {
  await stack.down();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
