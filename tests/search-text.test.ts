/**
 * tests/search-text.test.ts
 *
 * Regression tests for the pure-JS search_text fallback (searchTextFallback),
 * used when rg is unavailable or fails (e.g. Windows .cmd shim issues).
 *
 * Uses Node.js built-in test runner (node:test) — no extra deps.
 * Run with:  node --import tsx/esm --test tests/search-text.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchTextFallback } from '../src/infra/tools.js';

let tmpDir: string;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'search-text-test-'));
  await mkdir(join(tmpDir, 'src'), { recursive: true });
  await mkdir(join(tmpDir, '.git'), { recursive: true });
  await mkdir(join(tmpDir, 'node_modules', 'pkg'), { recursive: true });

  await writeFile(join(tmpDir, 'src', 'app.ts'), 'export function boot() {\n  thinkingBlocks.set(id, value);\n}\n', 'utf8');
  await writeFile(join(tmpDir, 'src', 'decoy.ts'), 'thinkingBlocksXset(id, value);\n', 'utf8');
  await writeFile(join(tmpDir, 'src', 'decoy.txt'), 'thinkingBlocks.set(id, value);\n', 'utf8');
  await writeFile(join(tmpDir, 'src', 'nums.ts'), 'const a = 42;\nconst b = abc;\n', 'utf8');
  await writeFile(join(tmpDir, 'src', 'literal.ts'), 'foo (unclosed bar\n', 'utf8');
  await writeFile(join(tmpDir, 'src', 'anchored.ts'), 'line one\ninline two\nline three\n', 'utf8');
  await writeFile(join(tmpDir, '.git', 'packed.ts'), 'thinkingBlocks.set(in Git object);\n', 'utf8');
  await writeFile(join(tmpDir, 'node_modules', 'pkg', 'index.ts'), 'thinkingBlocks.set(in dependency);\n', 'utf8');
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function lines(results: string[]): string[] {
  return results.map((r) => r.split(':')[1]!);
}

describe('searchTextFallback', () => {
  test('escaped-dot pattern matches thinkingBlocks.set but not thinkingBlocksXset', async () => {
    const results = await searchTextFallback(tmpDir, 'thinkingBlocks\\.set', '*.ts', 100);
    assert.ok(results.length > 0, 'expected at least one match');
    assert.ok(results.every((r) => !r.includes('thinkingBlocksXset')), `decoy matched: ${results.join('\n')}`);
    assert.ok(results.some((r) => r.includes('thinkingBlocks.set')), `no real match: ${results.join('\n')}`);
  });

  test('character-class pattern matches digits', async () => {
    const results = await searchTextFallback(tmpDir, '\\d+', '*.ts', 100);
    assert.ok(results.some((r) => r.includes('42')), `no digit match: ${results.join('\n')}`);
    assert.ok(!results.some((r) => r.includes('abc;')), `non-digit line matched: ${results.join('\n')}`);
  });

  test('invalid regex falls back to literal search without throwing', async () => {
    const results = await searchTextFallback(tmpDir, '(unclosed', '*.ts', 100);
    assert.deepEqual(results.map((r) => r.split(':')[0]!.replace(/\\/g, '/')), ['src/literal.ts']);
  });

  test('glob include filters to *.ts and skips .git and node_modules', async () => {
    const results = await searchTextFallback(tmpDir, 'thinkingBlocks\\.set', '*.ts', 100);
    const files = results.map((r) => r.split(':')[0]!.replace(/\\/g, '/'));
    assert.ok(files.every((f) => f.endsWith('.ts')), `non-ts file matched: ${files.join(', ')}`);
    assert.ok(!files.some((f) => f.startsWith('.git/')), `.git not skipped: ${files.join(', ')}`);
    assert.ok(!files.some((f) => f.includes('node_modules/')), `node_modules not skipped: ${files.join(', ')}`);
    assert.ok(files.includes('src/app.ts'), `app.ts missing: ${files.join(', ')}`);
    assert.ok(!files.includes('src/decoy.txt'), `.txt file leaked through glob: ${files.join(', ')}`);
  });

  test('per-line anchors work with the m flag', async () => {
    const results = await searchTextFallback(tmpDir, '^line', '*.ts', 100);
    assert.deepEqual(lines(results), ['1', '3']);
  });

  test('respects max results', async () => {
    const results = await searchTextFallback(tmpDir, 'thinkingBlocks\\.set', undefined, 1);
    assert.equal(results.length, 1);
  });
});
