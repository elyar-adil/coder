import { appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { executeTool } from '../../src/infra/tools.js';
import { FileLockManager } from '../../src/runtime/locks.js';
import { registerWorkspaceInstance } from '../../src/runtime/workspace-instances.js';

async function progress(file: string, line: string): Promise<void> {
  await appendFile(file, `${line}\n`, 'utf8');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Test helper run as a separate OS process so lock/liveness behavior can be
 * exercised across real process boundaries:
 *
 *   hold <lockDir> <target> <holdMs> <progressFile>
 *   edit <lockDir> <file> <count> <progressFile>
 *   register <workspace> <holdMs> <progressFile>
 */
const [, , mode, a, b, c, d] = process.argv;

if (mode === 'hold') {
  const locks = new FileLockManager(a);
  const release = await locks.acquire(resolve(b), 5_000);
  await progress(d, 'locked');
  await sleep(Number(c));
  await release();
  await progress(d, 'released');
} else if (mode === 'edit') {
  const file = resolve(b);
  const count = Number(c);
  const locks = new FileLockManager(a);
  const context = {
    workspaceRoot: dirname(file),
    acquireWriteLock: (path: string) => locks.acquire(path),
  };
  // File init happens in the parent test before spawning, so concurrent
  // children never race their own startup write against each other's edits.
  for (let i = 1; i <= count; i += 1) {
    // Contention is expected here. A busy CI scheduler can make the other
    // writer's release land a moment late (acquire timeout) or between this
    // process's read and re-read (stale-lease refusal at the optimistic
    // conflict check). Both are transient; retrying the same edit is what a
    // real client does.
    for (let attempt = 0; ; attempt += 1) {
      const result = await executeTool('edit_file', {
        path: file,
        edits: JSON.stringify([{ search: 'END', replace: `${process.pid}:${i}\nEND` }]),
      }, context);
      if (result.startsWith('OK')) break;
      const transient = /changed after it was read|changed underneath|read lease is stale|before timeout|held by another process/i.test(result);
      if (!transient || attempt >= 20) {
        await progress(d, `failed: ${result.split('\n')[0]}`);
        process.exit(1);
      }
      await sleep(25 + 25 * attempt);
    }
  }
  await progress(d, 'done');
} else if (mode === 'register') {
  const stop = await registerWorkspaceInstance(resolve(a));
  await progress(c, 'registered');
  await sleep(Number(b));
  await stop();
  await progress(c, 'stopped');
}
