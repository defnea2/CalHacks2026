import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Reading an env key the schema does not declare is a FATAL module error at runtime (EnvGet
// "environment key is not declared"), not a catchable exception; unit tests use an override map
// and never see it. So every EnvName must appear in the schema's env block, and publish must pass it.
const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

describe('module env keys', () => {
  it('every EnvName in env.ts is declared in schema.ts and forwarded by scripts/publish.mjs', () => {
    const env = src('src/env.ts');
    const union = env.slice(env.indexOf('export type EnvName'), env.indexOf(';', env.indexOf('export type EnvName')));
    const names = [...union.matchAll(/'([A-Z0-9_]+)'/g)].map(m => m[1]!);
    expect(names.length).toBeGreaterThan(10);
    const schema = src('src/schema.ts');
    const block = schema.slice(schema.indexOf('env: {'));
    const publish = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'publish.mjs'), 'utf8');
    for (const n of names) {
      expect(block, `${n} declared in schema env`).toMatch(new RegExp(`\\b${n}:`));
      expect(publish, `${n} forwarded by publish.mjs`).toContain(n);
    }
  });
});
