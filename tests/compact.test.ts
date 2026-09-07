import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatChunk } from '../src/backend.js';
import { AgentRegistry } from '../src/runtime/agent-registry.js';
import { AgentRuntime } from '../src/runtime/agent-runtime.js';
import { AgentRuntimeStore } from '../src/runtime/agent-store.js';

const document = (description: string, agents: string[] = []): string => `---
description: ${description}
model: inherit
tools: []
agents: [${agents.join(', ')}]
---

Act according to this test spec.
`;

async function fixture(options: { contextWindow?: number } = {}): Promise<{ runtime: AgentRuntime; root: string; store: AgentRuntimeStore }> {
  const root = await mkdtemp(join(tmpdir(), 'coder-compact-'));
  const agents = join(root, 'agents');
  const emptyUser = join(root, 'user');
  const emptyProject = join(root, 'project');
  await Promise.all([mkdir(agents), mkdir(emptyUser), mkdir(emptyProject)]);
  await writeFile(join(agents, 'main.md'), document('Entry', ['coordinator']));
  await writeFile(join(agents, 'coordinator.md'), document('Coordinator'));
  const registry = new AgentRegistry({ builtinDir: agents, userDir: emptyUser, projectDir: emptyProject });
  const store = new AgentRuntimeStore(root);
  const runtime = new AgentRuntime({
    registry,
    store,
    workspaceRoot: root,
    defaultModel: 'test',
    resolveModel: () => ({ type: 'ollama', baseUrl: 'http://test', model: 'test', ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}) }),
    modelStream,
  });
  await runtime.whenReady();
  return { runtime, root, store };
}

function baseModelStream(): ConstructorParameters<typeof AgentRuntime>[0]['modelStream'] {
  return async function* (_config, system, messages): AsyncGenerator<ChatChunk> {
    if (system.includes('context compaction assistant')) {
      yield { content: 'digest of earlier conversation', done: false };
      yield { content: null, done: true };
      return;
    }
    const latest = String(messages.at(-1)?.content ?? '');
    yield { content: `reply to ${latest.replace(/^User message:\n/, '')}`, done: false };
    yield { content: null, done: true };
  };
}

let overrideModelStream: ConstructorParameters<typeof AgentRuntime>[0]['modelStream'] | undefined;
const modelStream: ConstructorParameters<typeof AgentRuntime>[0]['modelStream'] = (config, system, messages, tools, signal) => (
  (overrideModelStream ?? baseModelStream())(config, system, messages, tools, signal)
);

const longText = (marker: string, length = 300): string => `${marker} ${'padding '.repeat(Math.ceil(length / 8))}`;

describe('context compaction', () => {
  const previousRatio = process.env.AGENT_AUTO_COMPACT_RATIO;

  afterEach(() => {
    overrideModelStream = undefined;
    if (previousRatio === undefined) delete process.env.AGENT_AUTO_COMPACT_RATIO;
    else process.env.AGENT_AUTO_COMPACT_RATIO = previousRatio;
  });

  test('manual compact digests old messages, archives them, and archives stay searchable', async () => {
    const { runtime, root, store } = await fixture();
    try {
      const session = await runtime.openSession('compact-manual');
      const mainId = session.mainInstanceId;
      for (let turn = 0; turn < 8; turn += 1) {
        await runtime.submitMessage('compact-manual', longText(`needle-${turn === 3 ? 'special' : turn}`));
        await runtime.waitForIdle('compact-manual');
      }
      const before = runtime.getInstance(mainId)!.messages.length;
      const detail = await runtime.compactInstance(mainId, { keepRecent: 6 });
      assert.match(detail, /Archived 10 older messages/);

      const compacted = runtime.getInstance(mainId)!;
      assert.equal(compacted.compactionCount, 1);
      assert.ok(compacted.messages[0]!.content!.includes('<context-digest'));
      assert.equal(compacted.messages.length, 7);
      assert.ok(before > compacted.messages.length);

      const archives = await store.loadArchives('compact-manual', mainId);
      assert.equal(archives.length, 1);
      assert.equal(archives[0]!.messages.length, 10);

      const hit = await runtime.searchArchivedContext(mainId, 'needle-special');
      assert.ok(hit.includes('needle-special'), `search should find archived content, got: ${hit}`);
      const miss = await runtime.searchArchivedContext(mainId, 'not-present-anywhere');
      assert.match(miss, /No archived context matches/);

      // Compact again archives under the next sequence number.
      await runtime.compactInstance(mainId, { keepRecent: 1 });
      assert.equal((await store.loadArchives('compact-manual', mainId)).length, 2);
      assert.equal(runtime.getInstance(mainId)!.compactionCount, 2);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('compact_context tool schedules self-compaction at the next safe boundary', async () => {
    const { runtime, root, store } = await fixture();
    try {
      const session = await runtime.openSession('compact-tool');
      const mainId = session.mainInstanceId;
      for (let turn = 0; turn < 6; turn += 1) {
        await runtime.submitMessage('compact-tool', longText(`history-${turn}`));
        await runtime.waitForIdle('compact-tool');
      }
      overrideModelStream = async function* (_config, system, messages): AsyncGenerator<ChatChunk> {
        if (system.includes('context compaction assistant')) {
          yield { content: 'digest of earlier conversation', done: false };
          yield { content: null, done: true };
          return;
        }
        if (messages.some((message) => String(message.content ?? '').includes('<context-digest'))) {
          yield { content: 'resumed after compaction', done: false };
          yield { content: null, done: true };
          return;
        }
        const latest = String(messages.at(-1)?.content ?? '');
        if (latest.includes('do the compact')) {
          yield {
            content: null,
            toolCalls: [{ id: 'c1', function: { name: 'compact_context', arguments: { keep_recent: 2 } } }],
            done: false,
          };
          yield { content: null, done: true };
          return;
        }
        yield { content: `reply to ${latest}`, done: false };
        yield { content: null, done: true };
      };

      await runtime.submitMessage('compact-tool', 'do the compact now');
      await runtime.waitForIdle('compact-tool');

      const main = runtime.getInstance(mainId)!;
      assert.equal(main.compactionCount, 1);
      assert.ok(main.messages[0]!.content!.includes('<context-digest'));
      assert.equal(main.messages.at(-1)!.role, 'assistant');
      assert.equal(main.pendingCompact, undefined);
      const visible = (await store.load('compact-tool'))!.session.messages;
      assert.ok(visible.some((message) => message.content === 'resumed after compaction'));
      assert.ok((await store.loadArchives('compact-tool', mainId)).length, 1);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('auto-compact triggers when context exceeds the configured ratio', async () => {
    process.env.AGENT_AUTO_COMPACT_RATIO = '0.1';
    const { runtime, root } = await fixture({ contextWindow: 2000 });
    try {
      const session = await runtime.openSession('compact-auto');
      const mainId = session.mainInstanceId;
      for (let turn = 0; turn < 9; turn += 1) {
        await runtime.submitMessage('compact-auto', longText(`auto-${turn}`));
        await runtime.waitForIdle('compact-auto');
      }
      await runtime.submitMessage('compact-auto', longText('auto-trigger'));
      await runtime.waitForIdle('compact-auto');

      const main = runtime.getInstance(mainId)!;
      assert.equal(main.compactionCount, 1);
      assert.ok(main.messages[0]!.content!.includes('<context-digest'));
      assert.ok(main.messages.length < 20);
      const last = (await runtime.getSession('compact-auto'))!.messages.at(-1)!;
      assert.match(last.content, /reply to/);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('compact refuses short contexts and rejects running instances', async () => {
    const { runtime, root } = await fixture();
    try {
      const session = await runtime.openSession('compact-short');
      await runtime.submitMessage('compact-short', 'hello');
      await runtime.waitForIdle('compact-short');
      const mainId = session.mainInstanceId;
      const detail = await runtime.compactInstance(mainId);
      assert.match(detail, /too short to compact/);

      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      overrideModelStream = async function* () {
        await gate;
        yield { content: 'slow', done: false };
        yield { content: null, done: true };
      };
      await runtime.submitMessage('compact-short', 'start slow turn');
      await assert.rejects(() => runtime.compactInstance(mainId), /running/);
      release();
      await runtime.waitForIdle('compact-short');
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('search_history via the tool path rejects unrelated instances', async () => {
    const { runtime, root } = await fixture();
    try {
      const session = await runtime.openSession('compact-search');
      const mainId = session.mainInstanceId;
      const child = await runtime.spawnAgent(mainId, 'coordinator', 'explore');
      await runtime.waitForIdle('compact-search');
      // From the coordinator, the main instance is not a descendant.
      const result = await runtime.searchArchivedContext(mainId, 'anything');
      assert.match(result, /never been compacted/);
      void child;
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
