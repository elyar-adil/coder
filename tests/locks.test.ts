import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { LockConflictError, CrossProcessLockManager } from '../src/runtime/file-lock.js';
import { FileLockManager } from '../src/runtime/locks.js';
import { AgentRegistry } from '../src/runtime/agent-registry.js';
import { AgentRuntime } from '../src/runtime/agent-runtime.js';
import { AgentRuntimeStore } from '../src/runtime/agent-store.js';
import { executeTool } from '../src/infra/tools.js';
import type { ChatChunk } from '../src/backend.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'locks-test-'));
  // Session locks should fail fast in tests instead of polling for 5s.
  process.env.AGENT_SESSION_LOCK_TIMEOUT_MS = '400';
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Run the child helper as a real OS process. */
function runChild(args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolveDone) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', resolve('tests/helpers/lock-child.ts'), ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', () => undefined);
    child.on('close', (code) => resolveDone({ code, stdout }));
  });
}

async function waitForProgress(progressFile: string, line: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = await readFile(progressFile, 'utf8').catch(() => '');
    if (content.split('\n').includes(line)) return;
    if (Date.now() > deadline) throw new Error(`progress "${line}" not seen in ${progressFile}: ${content}`);
    await sleep(25);
  }
}

describe('FileLockManager (in-process)', () => {
  test('double release is idempotent and never hands the lock away early', async () => {
    const locks = new FileLockManager(join(root, 'inproc'));
    const target = join(root, 'inproc', 'file.txt');
    await mkdir(join(root, 'inproc'), { recursive: true });
    const first = await locks.acquire(target);
    let secondAcquired = false;
    const secondPromise = locks.acquire(target).then((release) => {
      secondAcquired = true;
      return release;
    });
    await sleep(20);
    await first();
    await first(); // A5 regression: second release must be a no-op
    const second = await secondPromise;
    assert.equal(secondAcquired, true);
    await second();
    const third = await locks.acquire(target);
    await third();
  });

  test('serializes concurrent in-process acquirers in FIFO order', async () => {
    const locks = new FileLockManager(join(root, 'fifo'));
    await mkdir(join(root, 'fifo'), { recursive: true });
    const target = join(root, 'fifo', 'f.txt');
    const order: string[] = [];
    const a = locks.acquire(target).then(async (release) => {
      await sleep(50);
      order.push('a');
      await release();
    });
    const b = locks.acquire(target).then(async (release) => {
      order.push('b');
      await release();
    });
    await Promise.all([a, b]);
    assert.deepEqual(order, ['a', 'b']);
  });
});

describe('FileLockManager (cross-process)', () => {
  test('a live holder in another process conflicts with holder pid surfaced', async () => {
    const lockDir = join(root, 'xp');
    await mkdir(lockDir, { recursive: true });
    const target = join(root, 'xp', 'shared.txt');
    const progressFile = join(root, 'xp', 'progress.log');
    const child = runChild(['hold', lockDir, target, '700', progressFile]);
    await waitForProgress(progressFile, 'locked');

    const locks = new FileLockManager(lockDir);
    await assert.rejects(
      () => locks.acquire(target, 300),
      (error: unknown) => {
        assert.ok(error instanceof LockConflictError);
        assert.match(error.message, /held by another process \(pid \d+/);
        assert.ok(error.holder && error.holder.live);
        assert.ok(error.holder.pid !== process.pid);
        return true;
      },
    );
    await waitForProgress(progressFile, 'released');
    const release = await locks.acquire(target, 1_000);
    await release();
    await child;
  });

  test('steals a lock left behind by a dead process', async () => {
    const lockDir = join(root, 'stale');
    await mkdir(lockDir, { recursive: true });
    const target = join(root, 'stale', 'orphan.txt');
    // Produce a genuinely dead pid.
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise<void>((resolveDone) => dead.on('close', () => resolveDone()));
    const lockPath = join(lockDir, 'orphan-lock');
    // Compute the same hashed path the manager uses.
    const { createHash } = await import('node:crypto');
    const hashed = createHash('sha1').update(resolve(target)).digest('hex');
    const lockFile = join(lockDir, `${hashed}.lock`);
    await writeFile(lockFile, `${JSON.stringify({
      v: 1, pid: dead.pid, startedAt: Date.now() - 60_000, nonce: 'dead',
      purpose: 'file', target: resolve(target), acquiredAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    void lockPath;
    const locks = new FileLockManager(lockDir);
    const release = await locks.acquire(target, 1_000);
    await release();
  });

  test('concurrent processes editing one file lose no edits (cross-process serialization)', async () => {
    const lockDir = join(root, 'edit-xp');
    await mkdir(lockDir, { recursive: true });
    const file = join(root, 'edit-xp', 'doc.txt');
    const p1 = join(root, 'edit-xp', 'p1.log');
    const p2 = join(root, 'edit-xp', 'p2.log');
    const each = 8;
    const [r1, r2] = await Promise.all([
      runChild(['edit', lockDir, file, String(each), p1]),
      runChild(['edit', lockDir, file, String(each), p2]),
    ]);
    assert.equal(r1.code, 0, `child1 stderr: ${r1.stdout}`);
    assert.equal(r2.code, 0, `child2 stderr: ${r2.stdout}`);
    const content = await readFile(file, 'utf8');
    for (let i = 1; i <= each; i += 1) {
      assert.match(content, new RegExp(`\\d+:${i}\\b`), `missing edit ${i}; content:\n${content}`);
    }
    const editCount = content.split('\n').filter((line) => /^\d+:\d+$/.test(line)).length;
    assert.equal(editCount, each * 2);
  });
});

// ── Session locks: read-only degradation, /fork escape, self-heal ────────────

const document = (description: string): string => `---
description: ${description}
model: inherit
tools: []
agents: []
---

Act according to this test spec.
`;

function textModel(): ConstructorParameters<typeof AgentRuntime>[0]['modelStream'] {
  return async function* (_config, _system, messages): AsyncGenerator<ChatChunk> {
    const latest = String(messages.at(-1)?.content ?? '');
    yield { content: `reply to ${latest}`, done: false };
    yield { content: null, done: true };
  };
}

async function makeRuntime(storeDir: string, registryDir: string): Promise<AgentRuntime> {
  const registry = new AgentRegistry({ builtinDir: registryDir, userDir: join(registryDir, 'u'), projectDir: join(registryDir, 'p') });
  const runtime = new AgentRuntime({
    registry,
    store: new AgentRuntimeStore(storeDir),
    workspaceRoot: root,
    defaultModel: 'test',
    resolveModel: () => ({ type: 'ollama', baseUrl: 'http://test', model: 'test' }),
    modelStream: textModel(),
  });
  await runtime.whenReady();
  return runtime;
}

describe('cross-process session access', () => {
  test('second opener is read-only, /fork escapes, writer exit self-heals', async () => {
    const storeDir = join(root, 'sess-store');
    const registryDir = join(root, 'sess-registry');
    await mkdir(join(registryDir, 'u'), { recursive: true });
    await mkdir(join(registryDir, 'p'), { recursive: true });
    await writeFile(join(registryDir, 'main.md'), document('Main'));

    const writer = await makeRuntime(storeDir, registryDir);
    const reader = await makeRuntime(storeDir, registryDir);
    try {
      await writer.openSession('s-lock');
      assert.deepEqual(reader.sessionAccess('s-lock'), { writable: true }); // not open yet in reader
      await reader.openSession('s-lock');
      const access = reader.sessionAccess('s-lock');
      assert.equal(access.writable, false);
      assert.equal(access.holderPid, process.pid); // same-process conflict is still reported

      await assert.rejects(
        () => reader.submitMessage('s-lock', 'hello'),
        (error: unknown) => {
          assert.match(String((error as Error).message), /read-only/);
          assert.match(String((error as Error).message), /\/fork/);
          return true;
        },
      );

      // /fork escape: the fork is writable for the reader.
      const fork = await reader.forkSession('s-lock', 's-lock-fork');
      assert.equal(fork.sessionId, 's-lock-fork');
      const turnId = await reader.submitMessage('s-lock-fork', 'continue here');
      await reader.waitForIdle('s-lock-fork', 10_000);
      assert.ok(turnId);

      // Writer exits → reader self-heals into the writer role.
      await writer.shutdown();
      const turn2 = await reader.submitMessage('s-lock', 'take over');
      await reader.waitForIdle('s-lock', 10_000);
      assert.ok(turn2);
      assert.equal(reader.sessionAccess('s-lock').writable, true);
    } finally {
      await writer.shutdown().catch(() => undefined);
      await reader.shutdown().catch(() => undefined);
    }
  });

  test('openSession of a brand-new id held by another writer fails with a clear error', async () => {
    const storeDir = join(root, 'sess-store2');
    const registryDir = join(root, 'sess-registry2');
    await mkdir(join(registryDir, 'u'), { recursive: true });
    await mkdir(join(registryDir, 'p'), { recursive: true });
    await writeFile(join(registryDir, 'main.md'), document('Main'));

    const reader = await makeRuntime(storeDir, registryDir);
    // Simulate a concurrent creator: hold the target session's lock without
    // having persisted anything yet.
    const squatter = new CrossProcessLockManager(resolve(storeDir, 'runtime', 'locks'));
    const store = new AgentRuntimeStore(storeDir);
    const held = await squatter.acquire(store.sessionPath('s-fresh'), { purpose: 'session:s-fresh', session: 's-fresh' });
    try {
      await assert.rejects(
        () => reader.openSession('s-fresh'),
        /currently being written by/,
      );
    } finally {
      await held.release();
      await reader.shutdown().catch(() => undefined);
    }
  });
});

describe('optimistic conflict detection', () => {
  test('write_file refuses to overwrite a file changed after it was read', async () => {
    const dir = join(root, 'stale-write');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'doc.txt');
    await writeFile(file, 'original\n', 'utf8');
    const versions = new Map<string, string>();
    const context = {
      workspaceRoot: dir,
      requirePriorRead: true,
      getReadVersion: (target: string) => versions.get(resolve(target)),
      recordReadVersion: (target: string, version: string) => versions.set(resolve(target), version),
      acquireWriteLock: (path: string) => new FileLockManager(join(dir, 'locks')).acquire(path),
    };
    await executeTool('read_file', { path: file }, context);
    await writeFile(file, 'changed externally\n', 'utf8');
    const result = await executeTool('write_file', { path: file, content: 'clobber' }, context);
    assert.match(result, /changed after it was read/);
    assert.equal(await readFile(file, 'utf8'), 'changed externally\n');
  });

  test('edit_file still applies when the lock context is provided and content is fresh', async () => {
    const dir = join(root, 'fresh-edit');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'doc.txt');
    await writeFile(file, 'hello\n', 'utf8');
    const locks = new FileLockManager(join(dir, 'locks'));
    const context = {
      workspaceRoot: dir,
      acquireWriteLock: (path: string) => locks.acquire(path),
    };
    const result = await executeTool('edit_file', {
      path: file,
      edits: JSON.stringify([{ search: 'hello', replace: 'hi' }]),
    }, context);
    assert.match(result, /^OK:/);
    assert.equal(await readFile(file, 'utf8'), 'hi\n');
  });
});
