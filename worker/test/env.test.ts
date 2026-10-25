import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { findEnvDir } from '../src/env';

describe('isolated checkout configuration', () => {
  it('uses this checkout’s env.local before an ancestor env file', () => {
    const root = mkdtempSync(join(tmpdir(), 'tutor-env-'));
    try {
      const child = join(root, 'checkout'); mkdirSync(child);
      writeFileSync(join(root, '.env'), 'SPACETIME_DB=another-checkout\n');
      writeFileSync(join(child, '.env.local'), 'SPACETIME_DB=this-checkout\n');
      expect(findEnvDir(child)).toBe(child);
    } finally { rmSync(root, { recursive: true }); }
  });
});
