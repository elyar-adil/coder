/**
 * tests/edit-file-sota.test.ts
 *
 * SOTA-alignment tests for edit_file: deterministic matching with enforced
 * uniqueness, expectedReplacements/replaceAll, no-op detection, and
 * post-write readback verification.
 *
 * Run with:  node --import tsx/esm --test tests/edit-file-sota.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeTool } from '../src/infra/tools.js';
import { withWriteLockProvider } from './helpers/lock-context.js';

let tmpDir: string;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'edit-file-sota-'));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('edit_file SOTA semantics', () => {
  test('multi-match ambiguity error lists line numbers', async () => {
    const path = join(tmpDir, 'ambiguous.txt');
    await writeFile(path, 'dup\nmid\ndup\nend\ndup', 'utf8');
    const result = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{ search: 'dup', replace: 'x' }]),
    });
    assert.match(result, /Found 3 matches of old text/);
    assert.match(result, /at lines 1, 3, 5/);
    assert.match(result, /Provide more surrounding context/);
    assert.equal(await readFile(path, 'utf8'), 'dup\nmid\ndup\nend\ndup');
  });

  test('ambiguity is enforced on normalized strategies too', async () => {
    const path = join(tmpDir, 'ambiguous-fuzzy.txt');
    await writeFile(path, '  foo\n  bar\nx\n  foo\n  bar', 'utf8');
    const result = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{ search: 'foo\nbar', replace: 'qux' }]),
    });
    assert.match(result, /Found 2 matches of old text/);
    assert.match(result, /at lines 1, 4/);
    assert.equal(await readFile(path, 'utf8'), '  foo\n  bar\nx\n  foo\n  bar');
  });

  test('escape-normalized edit works when the model sends literal \\n escapes', async () => {
    const path = join(tmpDir, 'escaped.txt');
    const original = 'function a() {\n  return 1;\n}\n';
    await writeFile(path, original, 'utf8');
    const result = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{
        search: 'function a() {\\n  return 1;\\n}',
        replace: 'function a() {\\n  return 2;\\n}',
      }]),
    });
    assert.match(result, /^OK:/);
    assert.equal(await readFile(path, 'utf8'), 'function a() {\n  return 2;\n}\n');
  });

  test('indentation-flexible edit works', async () => {
    const path = join(tmpDir, 'indent.txt');
    await writeFile(path, 'if (x) {\n    deeply({\n        value: 1,\n    });\n}\n', 'utf8');
    const result = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{
        search: 'deeply({\n    value: 1,\n});',
        replace: 'deeply({\n    value: 2,\n});',
      }]),
    });
    assert.match(result, /^OK:/);
    assert.equal(await readFile(path, 'utf8'), 'if (x) {\ndeeply({\n    value: 2,\n});\n}\n');
  });

  test('no-match error is actionable with a closest-lines hint', async () => {
    const path = join(tmpDir, 'nomatch.txt');
    await writeFile(path, 'foo\nbar\nbaz\nfoo', 'utf8');
    const result = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{ search: 'foo\nWRONG LINE', replace: 'x' }]),
    });
    assert.match(result, /Could not find old text/);
    assert.match(result, /must match exactly, including whitespace, indentation, and line endings/);
    assert.match(result, /near lines: 1, 4/);
  });

  test('no-op edit reports no changes and does not write', async () => {
    const path = join(tmpDir, 'noop.txt');
    const original = 'same text\nother\n';
    await writeFile(path, original, 'utf8');
    const result = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{ search: 'same text', replace: 'same text' }]),
    });
    assert.match(result, /no changes made/);
    assert.doesNotMatch(result, /sha256:/);
    assert.equal(await readFile(path, 'utf8'), original);
  });

  test('expectedReplacements enforcement fails with the actual count', async () => {
    const path = join(tmpDir, 'expected.txt');
    await writeFile(path, 'x y x z x', 'utf8');
    const result = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{ search: 'x', replace: 'q' }]),
      replaceAll: true,
      expectedReplacements: 2,
    });
    assert.match(result, /expected 2 occurrence\(s\).*but found 3/);
    assert.equal(await readFile(path, 'utf8'), 'x y x z x');
  });

  test('replaceAll replaces every occurrence and reports the count', async () => {
    const path = join(tmpDir, 'replace-all.txt');
    await writeFile(path, 'x y x z x', 'utf8');
    const result = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{ search: 'x', replace: 'q' }]),
      replaceAll: true,
    });
    assert.match(result, /^OK:/);
    assert.match(result, /replaced 3 occurrence\(s\)/);
    assert.equal(await readFile(path, 'utf8'), 'q y q z q');
  });

  test('replaceAll honors a matching expectedReplacements', async () => {
    const path = join(tmpDir, 'replace-all-expected.txt');
    await writeFile(path, 'dup a\ndup b', 'utf8');
    const result = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{ search: 'dup', replace: 'uniq' }]),
      replaceAll: true,
      expectedReplacements: 2,
    });
    assert.match(result, /^OK:/);
    assert.match(result, /replaced 2 occurrence\(s\)/);
    assert.equal(await readFile(path, 'utf8'), 'uniq a\nuniq b');
  });

  test('expectedReplacements > 1 without replaceAll fails with guidance', async () => {
    const path = join(tmpDir, 'expected-single.txt');
    await writeFile(path, 'only one here', 'utf8');
    const result = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{ search: 'one', replace: 'two' }]),
      expectedReplacements: 3,
    });
    assert.match(result, /expected 3 occurrence\(s\).*but found 1/);
    assert.match(result, /Set replaceAll: true/);
    assert.equal(await readFile(path, 'utf8'), 'only one here');
  });

  test('readback verification runs on success (sha256 and line counts reported)', async () => {
    const path = join(tmpDir, 'readback.txt');
    await writeFile(path, 'one\ntwo\nthree', 'utf8');
    const result = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{ search: 'two', replace: 'two\nextra' }]),
    });
    assert.match(result, /^OK:/);
    assert.match(result, /3 → 4 lines/);
    assert.match(result, /sha256:[0-9a-f]{12}/);
    assert.equal(await readFile(path, 'utf8'), 'one\ntwo\nextra\nthree');
  });

  test('session edit lease requires a prior read and rejects stale content', async () => {
    const path = join(tmpDir, 'leased.txt');
    await writeFile(path, 'before\n', 'utf8');
    const versions = new Map<string, string>();
    const context = withWriteLockProvider({
      requirePriorRead: true,
      getReadVersion: (target: string) => versions.get(target),
      recordReadVersion: (target: string, version: string) => versions.set(target, version),
    }, join(tmpDir, 'locks'));
    const missing = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{ search: 'before', replace: 'after' }]),
    }, context);
    assert.match(missing, /requires a prior read_file/);
    await executeTool('read_file', { path }, context);
    await writeFile(path, 'changed\n', 'utf8');
    const stale = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{ search: 'changed', replace: 'after' }]),
    }, context);
    assert.match(stale, /read lease is stale/);
  });

  test('no-match diagnostics include the closest window and diff', async () => {
    const path = join(tmpDir, 'closest.txt');
    await writeFile(path, 'function run() {\n  return 42;\n}\n', 'utf8');
    const result = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{ search: 'function run() {\n return 41;\n}', replace: 'x' }]),
    });
    assert.match(result, /Closest normalized window: lines 1-3/);
    assert.match(result, /```diff/);
    assert.match(result, /Next action: resubmit the exact matched text/);
  });

  test('failed edits leave no staging residue and keep the target unchanged', async () => {
    const path = join(tmpDir, 'staging.txt');
    const original = 'alpha\nbeta\n';
    await writeFile(path, original, 'utf8');
    const failed = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{ search: 'gamma', replace: 'x' }]),
    });
    assert.match(failed, /Could not find old text/);
    assert.equal(await readFile(path, 'utf8'), original);
    const residue = (await readdir(tmpDir)).filter((name) => name.includes('.staging'));
    assert.deepEqual(residue, []);
  });

  test('successful edits leave no staging residue', async () => {
    const path = join(tmpDir, 'staging-ok.txt');
    await writeFile(path, 'alpha\nbeta\n', 'utf8');
    const result = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{ search: 'alpha', replace: 'gamma' }]),
    });
    assert.match(result, /^OK:/);
    assert.equal(await readFile(path, 'utf8'), 'gamma\nbeta\n');
    const residue = (await readdir(tmpDir)).filter((name) => name.includes('.staging'));
    assert.deepEqual(residue, []);
  });
});
