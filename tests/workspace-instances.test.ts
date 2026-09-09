import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { otherWorkspaceInstances, registerWorkspaceInstance } from '../src/runtime/workspace-instances.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let root: string;
let previousDataHome: string | undefined;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'instances-test-'));
  previousDataHome = process.env.CODER_DATA_HOME;
  process.env.CODER_DATA_HOME = root;
});

after(async () => {
  if (previousDataHome === undefined) delete process.env.CODER_DATA_HOME;
  else process.env.CODER_DATA_HOME = previousDataHome;
  await rm(root, { recursive: true, force: true });
});

function runChild(args: string[]): Promise<{ code: number | null }> {
  return new Promise((resolveDone) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', resolve('tests/helpers/lock-child.ts'), 'register', ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, CODER_DATA_HOME: root },
    });
    child.on('close', (code) => resolveDone({ code }));
  });
}

async function waitForProgress(progressFile: string, line: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = await readFile(progressFile, 'utf8').catch(() => '');
    if (content.split('\n').includes(line)) return;
    if (Date.now() > deadline) throw new Error(`progress "${line}" not seen: ${content}`);
    await sleep(25);
  }
}

describe('workspace instances', () => {
  test('registers self, sees live child instances, ignores dead ones', async () => {
    const workspace = join(root, 'ws-a');
    await mkdir(workspace, { recursive: true });
    const progressFile = join(root, 'ws-a-progress.log');

    const stop = await registerWorkspaceInstance(workspace);
    try {
      const child = runChild([workspace, '400', progressFile]);
      await waitForProgress(progressFile, 'registered');
      const others = await otherWorkspaceInstances(workspace);
      assert.equal(others.length, 1);
      assert.ok(others[0]!.pid !== process.pid);
      await waitForProgress(progressFile, 'stopped');
      await child;
      const after = await otherWorkspaceInstances(workspace);
      assert.deepEqual(after, []);

      // A file left behind by a dead process must be ignored.
      const { createHash } = await import('node:crypto');
      const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
      await new Promise<void>((resolveDone) => dead.on('close', () => resolveDone()));
      const key = createHash('sha1').update(resolve(workspace)).digest('hex').slice(0, 16);
      await writeFile(
        join(root, 'runtime', 'instances', `${key}.${dead.pid}.json`),
        `${JSON.stringify({ pid: dead.pid, startedAt: 0, workspace, nonce: 'x', heartbeatAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8',
      );
      assert.deepEqual(await otherWorkspaceInstances(workspace), []);
    } finally {
      await stop();
    }
    assert.deepEqual(await otherWorkspaceInstances(workspace), []);
  });
});
