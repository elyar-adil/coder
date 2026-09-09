import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorktreeManager } from '../src/runtime/worktree.js';

const execFileAsync = promisify(execFile);

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'worktree-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd });
  return result.stdout;
}

async function initRepo(name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await writeFile(join(dir, 'app.txt'), 'v1\n', 'utf8');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

describe('WorktreeManager', () => {
  test('creates a managed worktree on its own branch and locks it', async () => {
    const repo = await initRepo('repo-a');
    const manager = new WorktreeManager(repo);
    assert.equal(await manager.isGitRepository(), true);

    const info = await manager.create('feature-auth');
    assert.equal(info.name, 'feature-auth');
    assert.equal(info.branch, 'maw/feature-auth');
    assert.equal(info.locked, true);
    assert.equal(info.dirty, false);
    assert.match(info.path, /\.coder[/\\]worktrees[/\\]feature-auth$/);
    assert.equal(await readFile(join(info.path, 'app.txt'), 'utf8'), 'v1\n');

    // Listed with fresh status.
    const all = await manager.list();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.locked, true);

    // The managed dir is kept out of the user's git status.
    const status = await git(repo, ['status', '--porcelain']);
    assert.equal(status.trim(), '');
  });

  test('copies gitignored files listed in .worktreeinclude', async () => {
    const repo = await initRepo('repo-b');
    await writeFile(join(repo, '.env'), 'SECRET=1\n', 'utf8');
    await writeFile(join(repo, '.worktreeinclude'), '# secrets\n.env\n', 'utf8');
    await writeFile(join(repo, '.gitignore'), '.env\n', 'utf8');
    await git(repo, ['add', '.gitignore', '.worktreeinclude']);
    await git(repo, ['commit', '-q', '-m', 'env']);

    const manager = new WorktreeManager(repo);
    const info = await manager.create('with-env');
    assert.equal(await readFile(join(info.path, '.env'), 'utf8'), 'SECRET=1\n');
  });

  test('reopen is idempotent and dirty worktrees refuse removal', async () => {
    const repo = await initRepo('repo-c');
    const manager = new WorktreeManager(repo);
    const first = await manager.create('fix-bug');
    const second = await manager.create('fix-bug');
    assert.equal(first.path, second.path);

    await appendFile(join(first.path, 'app.txt'), 'wip\n', 'utf8');
    const info = (await manager.list())[0]!;
    assert.equal(info.dirty, true);

    await assert.rejects(() => manager.remove('fix-bug'), /holds uncommitted changes/);
    // Force removal still works and keeps the branch.
    await manager.remove('fix-bug', { force: true });
    assert.deepEqual(await manager.list(), []);
    const branches = await git(repo, ['branch', '--list', 'maw/fix-bug']);
    assert.match(branches, /maw\/fix-bug/);
  });

  test('sweep removes clean worktrees but spares dirty or locked ones', async () => {
    const repo = await initRepo('repo-d');
    const manager = new WorktreeManager(repo);

    const clean = await manager.create('clean-wt');
    const dirtyWt = await manager.create('dirty-wt');
    const lockedWt = await manager.create('locked-wt');

    await appendFile(join(dirtyWt.path, 'app.txt'), 'change\n', 'utf8');
    // clean-wt stays clean but we unlock it; locked-wt keeps its lock.
    await git(repo, ['worktree', 'unlock', clean.path]);

    const removed = await manager.sweep();
    assert.ok(removed.includes('clean-wt'), `sweep should remove clean-wt, removed: ${removed.join(',')}`);
    assert.ok(!removed.includes('dirty-wt'));
    assert.ok(!removed.includes('locked-wt'));

    const remaining = await manager.list();
    assert.deepEqual(remaining.map((info) => info.name).sort(), ['dirty-wt', 'locked-wt']);
  });

  test('containing() maps a worktree path back to its record and rejects bad names', async () => {
    const repo = await initRepo('repo-e');
    const manager = new WorktreeManager(repo);
    const info = await manager.create('mapper');
    const found = await manager.containing(join(info.path, 'sub', 'file.txt'));
    assert.equal(found?.name, 'mapper');
    assert.equal(await manager.containing(repo), undefined);
    await assert.rejects(() => manager.create('../escape'), /name must be/);
    await assert.rejects(() => manager.create(''), /name must be/);
  });
});
