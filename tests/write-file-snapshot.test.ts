import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeTool } from '../src/infra/tools.js';
import { snapshotBeforeWrite } from '../src/infra/file-snapshot.js';
import { withWriteLockProvider } from './helpers/lock-context.js';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'write-snap-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('write_file snapshot', () => {
  test('overwriting an existing file creates a snapshot with old content', async () => {
    const ws = join(root, 'ws-a');
    await mkdir(ws, { recursive: true });
    const path = join(ws, 'target.txt');
    await writeFile(path, 'old line 1\nold line 2', 'utf8');

    const result = await executeTool('write_file', { path, content: 'new content' }, withWriteLockProvider({ workspaceRoot: ws }, root));
    assert.match(result, /^OK: wrote/);
    assert.match(result, /overwrote existing file \(2 lines\)/);
    const match = result.match(/snapshot saved to (\S+)/);
    assert.ok(match, `result missing snapshot path: ${result}`);
    const snapshotPath = match![1];
    assert.match(snapshotPath, /\.coder\/snapshots\//);
    assert.equal(await readFile(snapshotPath, 'utf8'), 'old line 1\nold line 2');
    assert.equal(await readFile(path, 'utf8'), 'new content');
  });

  test('creating a new file reports no snapshot and creates no snapshot file', async () => {
    const ws = join(root, 'ws-b');
    await mkdir(ws, { recursive: true });
    const path = join(ws, 'fresh.txt');

    const result = await executeTool('write_file', { path, content: 'created' }, withWriteLockProvider({ workspaceRoot: ws }, root));
    assert.match(result, /^OK: wrote/);
    assert.match(result, /created new file/);
    assert.doesNotMatch(result, /snapshot/);
    assert.equal(await readFile(path, 'utf8'), 'created');
    const snapshotsDir = join(ws, '.coder', 'snapshots');
    await assert.rejects(stat(snapshotsDir));
  });

  test('snapshots live under .coder/snapshots and do not pollute the target directory', async () => {
    const ws = join(root, 'ws-c');
    const targetDir = join(ws, 'sub', 'dir');
    await mkdir(targetDir, { recursive: true });
    const path = join(targetDir, 'note.txt');
    await writeFile(path, 'v1', 'utf8');

    const result = await executeTool('write_file', { path, content: 'v2' }, withWriteLockProvider({ workspaceRoot: ws }, root));
    const match = result.match(/snapshot saved to (\S+)/);
    assert.ok(match);
    const snapshotsDir = join(ws, '.coder', 'snapshots');
    const files = await readdir(snapshotsDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^sub_dir_note\.txt~\d{8}T\d+Z~[0-9a-f]+\.bak$/);
    const targetEntries = await readdir(targetDir);
    assert.deepEqual(targetEntries, ['note.txt']);
    assert.equal(await readFile(join(snapshotsDir, files[0]), 'utf8'), 'v1');
  });

  test('unwritable snapshot dir does not block the write and reports snapshot unavailable', async () => {
    const ws = join(root, 'ws-d');
    await mkdir(join(ws, '.coder', 'snapshots'), { recursive: true });
    const path = join(ws, 'guarded.txt');
    await writeFile(path, 'keep me', 'utf8');
    await chmod(join(ws, '.coder', 'snapshots'), 0o555);

    try {
      const result = await executeTool('write_file', { path, content: 'written anyway' }, withWriteLockProvider({ workspaceRoot: ws }, root));
      assert.match(result, /^OK: wrote/);
      assert.match(result, /overwrote existing file \(1 lines\)/);
      assert.match(result, /snapshot unavailable/);
      assert.equal(await readFile(path, 'utf8'), 'written anyway');
    } finally {
      await chmod(join(ws, '.coder', 'snapshots'), 0o755);
    }
  });

  test('snapshotBeforeWrite returns null for a nonexistent file', async () => {
    const missing = join(root, 'does-not-exist.txt');
    const snapshot = await snapshotBeforeWrite(missing);
    assert.deepEqual(snapshot, { path: null });
  });

  test('snapshotBeforeWrite never throws and degrades gracefully', async () => {
    const missing = join(root, 'missing-dir', 'file.txt');
    const snapshot = await snapshotBeforeWrite(missing, join(missing, 'not-a-dir'));
    assert.deepEqual(snapshot, { path: null });
  });
});
