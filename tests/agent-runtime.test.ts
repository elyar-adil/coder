import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatChunk } from '../src/backend.js';
import type { AgentModelMessage } from '../src/domain/agent.js';
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

async function fixture(
  modelStream: ConstructorParameters<typeof AgentRuntime>[0]['modelStream'],
  options: { maxConcurrentTurns?: number } = {},
): Promise<{
  runtime: AgentRuntime;
  root: string;
  store: AgentRuntimeStore;
}> {
  const root = await mkdtemp(join(tmpdir(), 'coder-agent-runtime-'));
  const agents = join(root, 'agents');
  const emptyUser = join(root, 'user');
  const emptyProject = join(root, 'project');
  await Promise.all([mkdir(agents), mkdir(emptyUser), mkdir(emptyProject)]);
  await writeFile(join(agents, 'main.md'), document('Entry', ['coordinator']));
  await writeFile(join(agents, 'coordinator.md'), document('Coordinator', ['worker']));
  await writeFile(join(agents, 'worker.md'), document('Worker'));
  const registry = new AgentRegistry({ builtinDir: agents, userDir: emptyUser, projectDir: emptyProject });
  const store = new AgentRuntimeStore(root);
  const runtime = new AgentRuntime({
    registry,
    store,
    workspaceRoot: root,
    defaultModel: 'test',
    resolveModel: () => ({ type: 'ollama', baseUrl: 'http://test', model: 'test' }),
    modelStream,
    maxConcurrentTurns: options.maxConcurrentTurns,
  });
  await runtime.whenReady();
  return { runtime, root, store };
}

function textModel(): ConstructorParameters<typeof AgentRuntime>[0]['modelStream'] {
  return async function* (_config, _system, messages): AsyncGenerator<ChatChunk> {
    const latest = String(messages.at(-1)?.content ?? '');
    yield { content: `reply to ${latest.replace(/^User message:\n/, '')}`, done: false };
    yield { content: null, done: true };
  };
}

describe('AgentRuntime', () => {
  test('keeps user messages in one session instead of creating tasks', async () => {
    const { runtime, root } = await fixture(textModel());
    try {
      await runtime.openSession('chat');
      await runtime.submitMessage('chat', 'first sentence');
      await runtime.waitForIdle('chat');
      await runtime.submitMessage('chat', 'second sentence');
      await runtime.waitForIdle('chat');
      const session = runtime.getSession('chat')!;
      assert.equal(session.messages.filter((message) => message.role === 'user').length, 2);
      assert.equal(session.messages.filter((message) => message.role === 'assistant').length, 2);
      assert.equal(runtime.listInstances('chat').length, 1);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('runs document-selected agents while keeping child output private', async () => {
    const model = async function* (_config: unknown, system: string, messages: AgentModelMessage[]): AsyncGenerator<ChatChunk> {
      const latest = messages.at(-1);
      if (system.includes('agent "main"')) {
        if (String(latest?.content).includes('User message:\nstart')) {
          yield { content: 'I am starting that now.', done: false };
          yield {
            content: null,
            toolCalls: [{ id: 'spawn-1', function: { name: 'spawn_agent', arguments: { agent: 'coordinator', message: 'coordinate this work' } } }],
            done: false,
          };
        } else if (latest?.role === 'tool') {
          yield { content: 'The coordinator is working in the background.', done: false };
        } else {
          yield { content: 'The coordinated work is complete.', done: false };
        }
      } else {
        yield { content: 'private coordinator result', done: false };
      }
      yield { content: null, done: true };
    };
    const { runtime, root } = await fixture(model);
    try {
      await runtime.openSession('delegation');
      await runtime.submitMessage('delegation', 'start');
      await runtime.waitForIdle('delegation');
      const instances = runtime.listInstances('delegation');
      assert.equal(instances.some((item) => item.agentId === 'coordinator'), true);
      const visible = runtime.getSession('delegation')!.messages.filter((message) => message.role === 'assistant').map((message) => message.content);
      assert.equal(visible.includes('private coordinator result'), false);
      assert.ok(visible.some((message) => message.includes('starting')));
      assert.ok(visible.some((message) => message.includes('complete')));
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('enforces agent selectors, depth cycles, messaging, and cancellation', async () => {
    const { runtime, root } = await fixture(textModel());
    try {
      const session = await runtime.openSession('lifecycle');
      const coordinatorId = await runtime.spawnAgent(session.mainInstanceId, 'coordinator', 'work');
      await assert.rejects(runtime.spawnAgent(session.mainInstanceId, 'worker', 'not allowed'), /cannot call/);
      await assert.rejects(runtime.spawnAgent(coordinatorId, 'main', 'cycle'), /cannot call|cycle/);
      await runtime.sendAgent(session.mainInstanceId, coordinatorId, 'new requirement');
      await runtime.cancelAgent(session.mainInstanceId, coordinatorId);
      assert.equal(runtime.getInstance(coordinatorId)?.status, 'cancelled');
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('waiting yields concurrency so all requested siblings can finish', async () => {
    const model = async function* (_config: unknown, system: string, messages: AgentModelMessage[]): AsyncGenerator<ChatChunk> {
      const latest = messages.at(-1);
      if (system.includes('agent "main"')) {
        if (String(latest?.content).includes('User message:\nparallel')) {
          yield { content: 'Starting parallel work.', done: false };
          yield { content: null, toolCalls: [{ id: 'c', function: { name: 'spawn_agent', arguments: { agent: 'coordinator', message: 'parallelize' } } }], done: false };
        } else if (latest?.role === 'tool') {
          yield { content: 'Coordinator started.', done: false };
        } else {
          yield { content: 'All parallel work completed.', done: false };
        }
      } else if (system.includes('agent "coordinator"')) {
        const spawnResults = messages.filter((message) => message.role === 'tool' && /^[0-9a-f-]{36}$/.test(String(message.content)));
        if (spawnResults.length === 0) {
          yield {
            content: null,
            toolCalls: Array.from({ length: 4 }, (_, index) => ({
              id: `w${index}`,
              function: { name: 'spawn_agent', arguments: { agent: 'worker', message: `work ${index}` } },
            })),
            done: false,
          };
        } else if (!messages.some((message) => message.role === 'tool' && String(message.content).startsWith('[{'))) {
          yield {
            content: null,
            toolCalls: [{
              id: 'wait',
              function: { name: 'wait_agent', arguments: { instance_ids: JSON.stringify(spawnResults.map((message) => message.content)) } },
            }],
            done: false,
          };
        } else {
          yield { content: 'coordinator complete', done: false };
        }
      } else {
        yield { content: 'worker complete', done: false };
      }
      yield { content: null, done: true };
    };
    const { runtime, root } = await fixture(model, { maxConcurrentTurns: 2 });
    try {
      await runtime.openSession('parallel-wait');
      await runtime.submitMessage('parallel-wait', 'parallel');
      await runtime.waitForIdle('parallel-wait', 5_000);
      const workers = runtime.listInstances('parallel-wait').filter((instance) => instance.agentId === 'worker');
      assert.equal(workers.length, 4);
      assert.ok(workers.every((worker) => worker.status === 'idle'));
      assert.ok(runtime.getSession('parallel-wait')?.messages.some((message) => message.content === 'All parallel work completed.'));
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('new user input interrupts main without cancelling background agents', async () => {
    const wait = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolveWait, reject) => {
      const timer = setTimeout(resolveWait, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      }, { once: true });
    });
    const model = async function* (_config: unknown, system: string, messages: AgentModelMessage[], _tools: unknown, signal?: AbortSignal): AsyncGenerator<ChatChunk> {
      if (system.includes('agent "coordinator"')) {
        await wait(80, signal);
        yield { content: 'background result', done: false };
      } else {
        const latest = String(messages.at(-1)?.content ?? '');
        if (latest.includes('first')) await wait(500, signal);
        const hasSecond = messages.some((message) => String(message.content).includes('second'));
        yield { content: hasSecond ? 'second accepted' : 'first should be interrupted', done: false };
      }
      yield { content: null, done: true };
    };
    const { runtime, root } = await fixture(model, { maxConcurrentTurns: 2 });
    try {
      const session = await runtime.openSession('interrupt');
      const coordinatorId = await runtime.spawnAgent(session.mainInstanceId, 'coordinator', 'keep running');
      await runtime.submitMessage('interrupt', 'first');
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      await runtime.submitMessage('interrupt', 'second');
      await runtime.waitForIdle('interrupt', 5_000);
      assert.equal(runtime.getInstance(coordinatorId)?.status, 'idle');
      assert.equal(runtime.getInstance(coordinatorId)?.lastOutput, 'background result');
      const visible = runtime.getSession('interrupt')!.messages.filter((message) => message.role === 'assistant').map((message) => message.content);
      assert.ok(visible.includes('second accepted'));
      assert.equal(visible.includes('first should be interrupted'), false);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('restores sessions and agent instances from the runtime store', async () => {
    const first = await fixture(textModel());
    const root = first.root;
    try {
      await first.runtime.openSession('persisted');
      await first.runtime.submitMessage('persisted', 'remember me');
      await first.runtime.waitForIdle('persisted');
      await first.runtime.shutdown();

      const agents = join(root, 'agents');
      const registry = new AgentRegistry({ builtinDir: agents, userDir: join(root, 'user'), projectDir: join(root, 'project') });
      const runtime = new AgentRuntime({
        registry,
        store: first.store,
        workspaceRoot: root,
        resolveModel: () => ({ type: 'ollama', baseUrl: 'http://test', model: 'test' }),
        modelStream: textModel(),
      });
      await runtime.openSession('persisted');
      assert.equal(runtime.getSession('persisted')?.messages.some((message) => message.content === 'remember me'), true);
      assert.equal(runtime.listInstances('persisted').length, 1);
      await runtime.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
