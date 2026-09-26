import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRuntimeStore } from '../src/runtime/agent-store.js';

test('corrupt sessions are surfaced without overwriting the original file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maw-store-corrupt-'));
  try {
    const store = new AgentRuntimeStore(root);
    await store.init();
    const path = store.sessionPath('broken');
    await writeFile(path, '{ definitely not json', 'utf8');

    await assert.rejects(store.load('broken'), /corrupt and was not overwritten/);
    assert.equal(await readFile(path, 'utf8'), '{ definitely not json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
