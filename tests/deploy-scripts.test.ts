// @vitest-environment node
// The operator scripts honour SPACETIME_SERVER / SPACETIME_DB, refuse an unconfirmed remote
// target and print the exact CLI commands with --dry-run (docs/DEPLOY.md). SPACETIME_BIN points
// at a path that does not exist, so any command that actually tried to run would fail the test.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = '/nonexistent/spacetime';
const REMOTE = { SPACETIME_SERVER: 'maincloud', SPACETIME_DB: 'fibonacci-demo' };
const KEYS = { CARTESIA_API_KEY: 'test-cartesia', ANTHROPIC_API_KEY: 'test-anthropic', STT_BASE_URL: 'https://api.cartesia.ai', CARTESIA_STT_MODEL: 'ink-whisper' };

function run(script: string, args: string[], env: Record<string, string>) {
  const base = { ...process.env };
  for (const k of ['SPACETIME_SERVER', 'SPACETIME_DB', 'AGENT_SECRET', 'STT_BASE_URL', 'INSIGHTS_KEY']) delete base[k];
  const r = spawnSync('node', [path.join('scripts', script), ...args], { cwd: ROOT, env: { ...base, SPACETIME_BIN: BIN, ...env }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('publish.mjs', () => {
  it('prints the remote command and module env names on --dry-run, without running it', () => {
    const r = run('publish.mjs', ['--dry-run'], { ...REMOTE, ...KEYS, AGENT_SECRET: 'cloud-secret', INSIGHTS_KEY: 'k' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('target: server=maincloud db=fibonacci-demo  [REMOTE]');
    expect(r.out).toContain(`[dry-run] (cd ${ROOT} && ${BIN} publish fibonacci-demo --server maincloud --module-path spacetimedb --yes)`);
    expect(r.out).toMatch(/module env: CARTESIA_API_KEY, AGENT_SECRET, STT_BASE_URL, CARTESIA_STT_MODEL, INSIGHTS_KEY, ANTHROPIC_API_KEY/);
    expect(r.out).not.toContain('cloud-secret');
    expect(r.out).not.toContain('test-cartesia');
  });

  it('refuses a remote server without --yes-remote', () => {
    const r = run('publish.mjs', [], { ...REMOTE, ...KEYS, AGENT_SECRET: 'cloud-secret' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('--yes-remote');
  });

  it('refuses --clear on a remote server without --yes-delete-remote-data', () => {
    const r = run('publish.mjs', ['--clear', '--yes-remote'], { ...REMOTE, ...KEYS, AGENT_SECRET: 'cloud-secret' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('--yes-delete-remote-data');
    const ok = run('publish.mjs', ['--clear', '--yes-remote', '--yes-delete-remote-data', '--dry-run'], { ...REMOTE, ...KEYS, AGENT_SECRET: 'cloud-secret' });
    expect(ok.status).toBe(0);
    expect(ok.out).toContain('--delete-data=always');
  });

  it('requires a public STT_BASE_URL and a separate AGENT_SECRET for a remote server', () => {
    expect(run('publish.mjs', ['--dry-run'], { ...REMOTE, ...KEYS, STT_BASE_URL: 'http://127.0.0.1:8787', AGENT_SECRET: 's' }).out).toContain('STT_BASE_URL');
    expect(run('publish.mjs', ['--dry-run'], { ...REMOTE, ...KEYS }).out).toContain('fresh AGENT_SECRET');
  });

  it('defaults to the local server, without confirmation', () => {
    const r = run('publish.mjs', ['--dry-run'], { CARTESIA_API_KEY: 'x', ANTHROPIC_API_KEY: 'y', SPACETIME_DB: 'night-test' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('publish night-test --server local ');
    const loop = run('publish.mjs', ['--dry-run'], { CARTESIA_API_KEY: 'x', ANTHROPIC_API_KEY: 'y', SPACETIME_SERVER: 'http://127.0.0.1:3000' });
    expect(loop.out).not.toContain('[REMOTE]');
  });
});

describe('seed-demo.mjs / simulate.mjs', () => {
  it('seed-demo --dry-run prints every command against the remote target and masks the secret', () => {
    const r = run('seed-demo.mjs', ['--dry-run'], { ...REMOTE, AGENT_SECRET: 'cloud-secret' });
    expect(r.status).toBe(0);
    expect(r.out).toContain(`[dry-run] ${BIN} sql --no-config --server maincloud fibonacci-demo 'SELECT * FROM learner'`);
    expect(r.out).toContain(`${BIN} call --no-config --server maincloud fibonacci-demo create_teacher '"Ms. Park"'`);
    expect(r.out).toContain(`register_agent '"<secret>"'`);
    expect(r.out).not.toContain('cloud-secret');
    expect(r.out).not.toMatch(/--server local/);
  });

  it('seed-demo and simulate refuse a remote target without --yes-remote', () => {
    expect(run('seed-demo.mjs', [], REMOTE).status).toBe(1);
    const sim = run('simulate.mjs', [], REMOTE);
    expect(sim.status).toBe(1);
    expect(sim.out).toContain('--yes-remote');
  });

  it('simulate --dry-run prints the class start against the remote target', () => {
    const r = run('simulate.mjs', ['--dry-run', '--preset', 'B'], REMOTE);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`${BIN} call --no-config --server maincloud fibonacci-demo start_class_session_with '<teacher id>'`);
  });

  it('simulate defaults to --server local', () => {
    const r = run('simulate.mjs', ['--dry-run', '--reset-only'], {});
    expect(r.out).toContain(`${BIN} call --no-config --server local voice-tutor reset_simulated_students 0`);
  });
});
