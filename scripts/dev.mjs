// One command for local development: starts SpacetimeDB (if not running), publishes the module,
// regenerates bindings, then runs stt-proxy, worker and client with prefixed logs.
// Usage: node scripts/dev.mjs [--clear] [--no-client]     (Ctrl+C stops everything it started)
import { spawn, spawnSync } from 'node:child_process';
import { spacetimeCommand } from './spacetime.mjs';
import { ROOT, loadEnv } from './env.mjs';

const NO_PROXY = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
const env = { ...loadEnv(), ...process.env, ...NO_PROXY, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` };
const children = [];
const provider = env.LLM_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : 'openrouter');
const required = ['CARTESIA_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', ...(provider === 'anthropic' ? ['ANTHROPIC_API_KEY'] : [])];
const missing = required.filter(key => !env[key]?.trim());
if (missing.length) {
  console.error(`Missing local voice configuration: ${missing.join(', ')}. Fill .env.local before starting.`);
  process.exit(1);
}


function run(name, cmd, args, color) {
  const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = stream => {
    let rest = '';
    stream.on('data', d => {
      const lines = (rest + d).split('\n');
      rest = lines.pop();
      for (const l of lines) process.stdout.write(tag + l + '\n');
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', code => process.stdout.write(`${tag}exited (${code})\n`));
  children.push(child);
  return child;
}

async function up(url) {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await up(url)) return;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${url}`);
}

const cli = spacetimeCommand(env);

if (!(await up('http://127.0.0.1:3000/v1/ping'))) {
  run('stdb', cli.command, [...cli.prefix, 'start', '--listen-addr', '127.0.0.1:3000', '--data-dir', './.spacetime-data', '--non-interactive'], '35');
  await waitFor('http://127.0.0.1:3000/v1/ping');
}
const publishArgs = ['scripts/publish.mjs', ...(process.argv.includes('--clear') ? ['--clear'] : [])];
if (spawnSync('node', publishArgs, { cwd: ROOT, env, stdio: 'inherit' }).status !== 0) process.exit(1);
spawnSync('pnpm', ['stdb:generate'], { cwd: ROOT, env, stdio: 'inherit' });

if (!(await up('http://127.0.0.1:8787/health'))) run('stt', 'pnpm', ['--filter', 'stt-proxy', 'start'], '36');
run('worker', 'pnpm', ['--filter', 'worker', 'start'], '33');
if (!process.argv.includes('--no-client')) run('client', 'pnpm', ['--filter', 'client', 'dev', '--port', env.VOICE_CLIENT_PORT || '5175'], '32');

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
