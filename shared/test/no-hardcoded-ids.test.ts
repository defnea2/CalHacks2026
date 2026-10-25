/// <reference types="node" />
// Pack boundary: no code outside the lesson pack may write a phase id or board kind name
// as a string literal (spec "Replaceable lesson pack"). Everything must come from `pack`.
// Excluded: generated module_bindings, client/src/board (the renderer side of the pack
// boundary), tests. A line that uses the same word with an unrelated meaning (e.g. an OpenAI
// content part `{ type: 'text' }`) can opt out with a trailing `// pack-literal-ok` comment.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack } from '../src/lesson/index';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const SCAN_DIRS = ['spacetimedb/src', 'worker/src', 'client/src'];
const EXCLUDE_PATHS = ['client/src/board'];
const EXCLUDE_DIR_NAMES = new Set(['node_modules', 'module_bindings', 'test', 'tests', '__tests__', 'dist', 'build']);
const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte)$/;
const TEST_FILE = /\.(test|spec)\.[a-z]+$/;
const OPT_OUT = 'pack-literal-ok';

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full).split(sep).join('/');
    if (statSync(full).isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(name) || EXCLUDE_PATHS.some(p => rel === p || rel.startsWith(`${p}/`))) continue;
      out.push(...listFiles(full));
    } else if (CODE_FILE.test(name) && !TEST_FILE.test(name)) out.push(full);
  }
  return out;
}

/** Blanks out comments (keeping line numbers) so ids mentioned in prose don't count. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map(line => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Finds quoted occurrences ('x', "x", `x`) of any of `ids` in `src`. */
export function findLiterals(src: string, ids: string[]): { line: number; id: string; text: string }[] {
  const rawLines = src.split('\n');
  const lines = stripComments(src).split('\n');
  const res = ids.map(id => ({ id, re: new RegExp(`(['"\`])${escapeRe(id)}\\1`, 'g') }));
  // `type: 'text'` / `.type === 'text'` are discriminators of other unions (OpenAI content parts,
  // LLM events), never a board kind or phase, so a literal right after `type` is not a hit.
  const isTypeDiscriminator = (line: string, at: number) => /\btype\s*(?::|===|!==|==|!=)\s*$/.test(line.slice(0, at));
  const hits: { line: number; id: string; text: string }[] = [];
  lines.forEach((line, i) => {
    if (rawLines[i]!.includes(OPT_OUT)) return;
    for (const { id, re } of res)
      for (const m of line.matchAll(re))
        if (!isTypeDiscriminator(line, m.index!)) {
          hits.push({ line: i + 1, id, text: rawLines[i]!.trim() });
          break;
        }
  });
  return hits;
}

const IDS = [...new Set([...pack.phases.map(p => p.id), ...pack.boardKinds.map(k => k.name)])];

describe('no hard-coded pack ids outside the pack', () => {
  it('scanner finds quoted ids and ignores comments, unquoted words and opt-outs', () => {
    const src = [
      "const a = 'diagnose';",
      'const b = { kind: "equation" };',
      'const c = `hand_back`;',
      '// set_phase to "intuition" here',
      '/* "visual" */ const d = 1;',
      'const e = diagnose_count; // a word, not a literal',
      "const f = { type: 'text' }; // pack-literal-ok (OpenAI content part)",
      "const g = 'https://x.dev/repair';",
    ].join('\n');
    const hits = findLiterals(src, ['diagnose', 'equation', 'hand_back', 'intuition', 'visual', 'text', 'repair']);
    expect(hits.map(h => [h.line, h.id])).toEqual([
      [1, 'diagnose'],
      [2, 'equation'],
      [3, 'hand_back'],
    ]);
  });

  it(`no phase id or board kind name as a string literal in ${SCAN_DIRS.join(', ')}`, () => {
    const violations: string[] = [];
    for (const dir of SCAN_DIRS)
      for (const file of listFiles(join(ROOT, dir)))
        for (const h of findLiterals(readFileSync(file, 'utf8'), IDS))
          violations.push(`${relative(ROOT, file)}:${h.line} "${h.id}": ${h.text}`);
    expect(violations, 'Use the lesson pack exports instead of writing phase ids or board kind names').toEqual([]);
  });
});
