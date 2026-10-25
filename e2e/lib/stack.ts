// Isolated test stack on the shared local SpacetimeDB server (127.0.0.1:3000, never stopped):
// its own database (default tutor-e2e, published with --clear), its own worker, its own Vite
// client on a free port. Everything started here is torn down by `down()`.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { loadKeys, NO_PROXY, OUT_DIR, parseEnvFile, ROOT, SPACETIME } from './env';

export interface StackOptions {
  db: string;
  clientPort: number;
  /** Module env for the test database. */
  moduleEnv: Record<string, string>;
  log: (m: string) => void;
}

export interface Stack {
  db: string;
  clientUrl: string;
  workerLog: string;
  clientLog: string;
  down(): Promise<void>;
  /** Worker log lines written so far. */
  workerLines(): string[];
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function freePort(from: number): Promise<number> {
  for (let p = from; p < from + 50; p++) {
    const ok = await new Promise<boolean>(res => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
    });
    if (ok) return p;
  }
  throw new Error(`no free port from ${from}`);
}

if (!process.env.PATH?.includes(path.dirname(SPACETIME))) process.env.PATH = `${path.dirname(SPACETIME)}:${process.env.PATH}`;

export function publish(o: StackOptions): void {
  if (o.db === 'tutor' || o.db === 'voice-tutor') throw new Error(`refusing to publish to the live database "${o.db}"`);
  const keys = loadKeys();
  const env = {
    ...process.env,
    ...NO_PROXY,
    CARTESIA_API_KEY: keys.CARTESIA_API_KEY ?? '',
    OPENROUTER_API_KEY: keys.OPENROUTER_API_KEY ?? '',
    OPENROUTER_MODEL: keys.OPENROUTER_MODEL ?? '',
    ...(keys.OPENROUTER_EXTRACTION_MODEL ? { OPENROUTER_EXTRACTION_MODEL: keys.OPENROUTER_EXTRACTION_MODEL } : {}),
    ...o.moduleEnv,
    SPACETIME_DB: o.db,
    SPACETIME_BIN: SPACETIME,
  };
  o.log(`publish ${o.db} (${Object.entries(o.moduleEnv).map(([k, v]) => `${k}=${v}`).join(' ')})`);
  const r = spawnSync('node', ['scripts/publish.mjs', '--clear'], { cwd: ROOT, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`publish failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
}

/** AGENT_SECRET as publish.mjs passed it (it creates ROOT/.env.local on first use). */
function agentSecret(): string {
  const s = parseEnvFile(path.join(ROOT, '.env.local')).AGENT_SECRET;
  if (!s) throw new Error('AGENT_SECRET missing in .env.local after publish');
  return s;
}

function startProc(cmd: string, args: string[], env: NodeJS.ProcessEnv, logFile: string): ChildProcess {
  const out = fs.openSync(logFile, 'w');
  // Own process group, so tsx/vite children die with it.
  return spawn(cmd, args, { cwd: ROOT, env, detached: true, stdio: ['ignore', out, out] });
}

async function killGroup(p: ChildProcess | undefined): Promise<void> {
  if (!p?.pid || p.exitCode !== null) return;
  const dead = new Promise<void>(r => p.once('exit', () => r()));
  try {
    process.kill(-p.pid, 'SIGTERM');
  } catch {
    return;
  }
  const t = await Promise.race([dead.then(() => true), sleep(3000).then(() => false)]);
  if (!t) {
    try {
      process.kill(-p.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

async function waitFor(what: string, ms: number, check: () => boolean | Promise<boolean>, proc?: ChildProcess): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (proc && proc.exitCode !== null) throw new Error(`${what}: process exited (${proc.exitCode})`);
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`${what}: timed out after ${ms} ms`);
}

/** Hex identity the spacetime CLI is logged in with. */
export function cliIdentity(): string {
  const r = spawnSync(SPACETIME, ['login', 'show'], { encoding: 'utf8', env: { ...process.env, ...NO_PROXY } });
  return (r.stdout + r.stderr).match(/\b(c2[0-9a-f]{62})\b/)?.[1] ?? '';
}

export async function up(o: StackOptions): Promise<Stack> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try {
    publish(o);
  } catch (e) {
    // The test database belongs to another CLI identity (someone logged the CLI out/in):
    // it cannot be cleared, so use a database name owned by the current identity.
    if (!/not authorized/.test(String(e))) throw e;
    const id = cliIdentity();
    const db = `${o.db}-${id.slice(2, 10) || 'alt'}`;
    o.log(`WARNING: CLI identity ${id.slice(0, 12)}… does not own ${o.db}; using ${db} instead`);
    o = { ...o, db };
    publish(o);
  }
  const secret = agentSecret();
  const workerLog = path.join(OUT_DIR, 'worker.log');
  const clientLog = path.join(OUT_DIR, 'client.log');
  const tokenFile = path.join(OUT_DIR, 'agent-token');
  fs.rmSync(tokenFile, { force: true });

  const procs: ChildProcess[] = [];
  const down = async () => {
    for (const p of procs.reverse()) await killGroup(p);
  };
  try {
    const worker = startProc(
      'pnpm',
      ['--filter', 'worker', 'start'],
      { ...process.env, ...NO_PROXY, SPACETIME_DB: o.db, AGENT_SECRET: secret, AGENT_TOKEN_FILE: tokenFile },
      workerLog
    );
    procs.push(worker);
    o.log(`worker pid ${worker.pid} -> ${path.relative(ROOT, workerLog)}`);
    const client = startProc(
      'pnpm',
      ['--filter', 'client', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(o.clientPort), '--strictPort'],
      { ...process.env, ...NO_PROXY, VITE_SPACETIME_DB: o.db },
      clientLog
    );
    procs.push(client);
    o.log(`client pid ${client.pid} on :${o.clientPort} -> ${path.relative(ROOT, clientLog)}`);
    await waitFor('worker registered as agent', 30_000, () => fs.readFileSync(workerLog, 'utf8').includes('registered as agent'), worker);
    const clientUrl = `http://127.0.0.1:${o.clientPort}/`;
    await waitFor('client dev server', 30_000, async () => {
      try {
        return (await fetch(clientUrl)).ok;
      } catch {
        return false;
      }
    }, client);
    return {
      db: o.db,
      clientUrl,
      workerLog,
      clientLog,
      down,
      workerLines: () => fs.readFileSync(workerLog, 'utf8').split('\n'),
    };
  } catch (e) {
    await down();
    throw e;
  }
}
