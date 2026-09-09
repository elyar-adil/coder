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
  options: { maxConcurrentTurns?: number; maxChildrenPerTurn?: number } = {},
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
    maxChildrenPerTurn: options.maxChildrenPerTurn,
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
  test('stops repeated identical tool failures as a doom loop', async () => {
    let call = 0;
    const { runtime, root } = await fixture(async function* () {
      call += 1;
      yield {
        content: null,
        toolCalls: [{ id: `failed-${call}`, function: { name: 'unknown_tool', arguments: { same: true } } }],
        done: false,
      };
      yield { content: null, done: true };
    });
    try {
      const session = await runtime.openSession('doom-loop');
      await runtime.submitMessage('doom-loop', 'start');
      await runtime.waitForIdle('doom-loop');
      const main = runtime.getInstance(session.mainInstanceId)!;
      assert.equal(main.status, 'failed');
      assert.match(main.lastError ?? '', /Doom loop detected/);
      assert.equal(call, 3);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('interleaved read-only successes do not reset the doom-loop failure chain', async () => {
    let call = 0;
    let editCalls = 0;
    const { runtime, root } = await fixture(async function* () {
      call += 1;
      if (call % 2 === 1) {
        editCalls += 1;
        yield {
          content: null,
          toolCalls: [{ id: `edit-${call}`, function: { name: 'edit_file', arguments: { path: 'target.txt', edits: JSON.stringify([{ search: 'absent text', replace: 'x' }]) } } }],
          done: false,
        };
      } else {
        yield {
          content: null,
          toolCalls: [{ id: `read-${call}`, function: { name: 'read_file', arguments: { path: 'target.txt' } } }],
          done: false,
        };
      }
      yield { content: null, done: true };
    });
    await writeFile(join(root, 'target.txt'), 'real content\n', 'utf8');
    try {
      const session = await runtime.openSession('doom-loop-oscillation');
      await runtime.submitMessage('doom-loop-oscillation', 'start');
      await runtime.waitForIdle('doom-loop-oscillation');
      const main = runtime.getInstance(session.mainInstanceId)!;
      assert.equal(main.status, 'failed');
      assert.match(main.lastError ?? '', /Doom loop detected/);
      assert.equal(editCalls, 3);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('main responds while the background concurrency budget is fully occupied', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const workerStarted = new Promise<void>(resolve => { started = resolve; });
    let responded!: () => void;
    const response = new Promise<void>(resolve => { responded = resolve; });
    const { runtime, root } = await fixture(async function* (_config, system) {
      if (system.includes('agent "coordinator"')) { started(); await gate; yield { content: 'background done', done: true }; }
      else { yield { content: 'available now', done: true }; }
    }, { maxConcurrentTurns: 1 });
    runtime.subscribe(event => { if (event.type === 'assistant_message') responded(); });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const session = await runtime.openSession('responsive');
      const child = await runtime.spawnAgent(session.mainInstanceId, 'coordinator', 'long task');
      await workerStarted;
      await runtime.submitMessage('responsive', 'status?');
      await Promise.race([response, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('main blocked behind worker')), 2000); })]);
      assert.equal(runtime.getInstance(child)?.status, 'running');
      release();
      await runtime.waitForIdle('responsive', 5000);
    } finally {
      clearTimeout(timeout); release(); await runtime.shutdown(); await rm(root, { recursive: true, force: true });
    }
  });

  test('persists prose and tools in actual execution order', async () => {
    let step = 0;
    const { runtime, root, store } = await fixture(async function* () {
      if (step++ === 0) {
        yield { content: 'Before tool', done: false };
        yield { content: null, toolCalls: [{ id: 'missing', function: { name: 'unknown_tool', arguments: {} } }], done: false };
      } else { yield { content: 'After tool', done: true }; }
    });
    try {
      await runtime.submitMessage('ordered', 'start');
      await runtime.waitForIdle('ordered');
      const entries = (await store.load('ordered'))!.session.timeline!;
      assert.deepEqual(entries.map(entry => entry.kind), ['message', 'message', 'tool', 'message']);
      assert.equal(entries[1]!.content, 'Before tool');
      assert.equal(entries[3]!.content, 'After tool');
      assert.equal(entries[2]!.status, 'failed');
    } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
  test('streams and persists provider thinking separately from the answer', async () => {
    const { runtime, root, store } = await fixture(async function* () {
      yield { content: null, thinking: 'Inspect. ', done: false };
      yield { content: null, thinking: 'Verify.', done: false };
      yield { content: 'Complete.', done: true };
    });
    const thinking: string[] = [];
    runtime.subscribe((event) => { if (event.type === 'thinking_delta') thinking.push(event.text); });
    try {
      await runtime.submitMessage('thinking', 'start');
      await runtime.waitForIdle('thinking');
      assert.equal(thinking.join(''), 'Inspect. Verify.');
      const answer = (await store.load('thinking'))!.session.messages.at(-1)!;
      assert.equal(answer.content, 'Complete.');
      assert.equal(answer.thinking, 'Inspect. Verify.');
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
  test('associates generated output with the submitted user turn', async () => {
    const { runtime, root } = await fixture(textModel());
    try {
      const turn = await runtime.submitMessage('association', 'hello');
      await runtime.waitForIdle('association');
      assert.equal(runtime.getSession('association')!.messages.at(-1)!.turnId, turn);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('records provider usage and turn latency without exposing provider details to the model', async () => {
    const { runtime, root } = await fixture(async function* () {
      yield { content: 'ok', done: false, usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 7 } };
      yield { content: null, done: true };
    });
    try {
      await runtime.submitMessage('usage', 'measure');
      await runtime.waitForIdle('usage');
      const instance = runtime.listInstances('usage')[0]!;
      assert.equal(instance.usage?.inputTokens, 10);
      assert.equal(instance.usage?.outputTokens, 2);
      assert.equal(instance.usage?.cachedInputTokens, 7);
      assert.equal(instance.usage?.requests, 1);
      assert.equal(instance.usage?.turns, 1);
      assert.equal(typeof instance.lastTurn?.durationMs, 'number');
    } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  test('stops the whole session and allows a fresh user turn', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let first = true;
    const { runtime, root } = await fixture(async function* (_config, _system, _messages, _tools, signal) {
      if (first) {
        first = false;
        started();
        await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
      } else yield { content: 'continued', done: false };
    });
    try {
      await runtime.submitMessage('stop', 'start');
      await ready;
      await runtime.cancelSession('stop');
      await runtime.waitForIdle('stop');
      assert.ok(runtime.listInstances('stop').every((instance) => instance.status === 'cancelled'));
      await runtime.submitMessage('stop', 'continue');
      await runtime.waitForIdle('stop');
      assert.equal(runtime.getSession('stop')!.messages.at(-1)!.content, 'continued');
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

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
    const { runtime, root } = await fixture(model, { maxConcurrentTurns: 2, maxChildrenPerTurn: 4 });
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

  test('injects workspace AGENTS.md into the agent system prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coder-agent-context-'));
    try {
      await mkdir(join(root, 'agents'));
      await writeFile(join(root, 'agents', 'main.md'), document('Entry'));
      await writeFile(join(root, 'AGENTS.md'), `# Workspace rules

Always run npm test before committing.
`);
      let systemPrompt = '';
      const runtime = new AgentRuntime({
        registry: new AgentRegistry({ builtinDir: join(root, 'agents'), userDir: join(root, 'user'), projectDir: join(root, 'project') }),
        store: new AgentRuntimeStore(root),
        workspaceRoot: root,
        defaultModel: 'test',
        resolveModel: () => ({ type: 'ollama', baseUrl: 'http://test', model: 'test' }),
        modelStream: async function* (_config, system): AsyncGenerator<ChatChunk> {
          systemPrompt = system;
          yield { content: 'ok', done: false };
          yield { content: null, done: true };
        },
      });
      await runtime.whenReady();
      await runtime.openSession('context');
      await runtime.submitMessage('context', 'hello');
      await runtime.waitForIdle('context');
      await runtime.shutdown();

      const specIndex = systemPrompt.indexOf('Act according to this test spec.');
      const contextIndex = systemPrompt.indexOf('Project context (AGENTS.md):');
      assert.ok(specIndex >= 0, 'spec instructions missing');
      assert.ok(contextIndex > specIndex, 'project context should follow spec instructions');
      assert.match(systemPrompt, /Always run npm test before committing\./);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('explicit projectContext option overrides workspace loading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coder-agent-context-'));
    try {
      await mkdir(join(root, 'agents'));
      await writeFile(join(root, 'agents', 'main.md'), document('Entry'));
      let systemPrompt = '';
      const runtime = new AgentRuntime({
        registry: new AgentRegistry({ builtinDir: join(root, 'agents'), userDir: join(root, 'user'), projectDir: join(root, 'project') }),
        store: new AgentRuntimeStore(root),
        workspaceRoot: root,
        defaultModel: 'test',
        resolveModel: () => ({ type: 'ollama', baseUrl: 'http://test', model: 'test' }),
        modelStream: async function* (_config, system): AsyncGenerator<ChatChunk> {
          systemPrompt = system;
          yield { content: 'ok', done: false };
          yield { content: null, done: true };
        },
        projectContext: 'Use tabs, never spaces.',
      });
      await runtime.whenReady();
      await runtime.openSession('context-option');
      await runtime.submitMessage('context-option', 'hello');
      await runtime.waitForIdle('context-option');
      await runtime.shutdown();

      assert.match(systemPrompt, /Use tabs, never spaces\./);
      assert.match(systemPrompt, /Project context \(AGENTS\.md\):/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('omits the project context section when no AGENTS.md exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coder-agent-context-'));
    try {
      await mkdir(join(root, 'agents'));
      await writeFile(join(root, 'agents', 'main.md'), document('Entry'));
      const systemPrompts: string[] = [];
      const runtime = new AgentRuntime({
        registry: new AgentRegistry({ builtinDir: join(root, 'agents'), userDir: join(root, 'user'), projectDir: join(root, 'project') }),
        store: new AgentRuntimeStore(root),
        workspaceRoot: root,
        defaultModel: 'test',
        resolveModel: () => ({ type: 'ollama', baseUrl: 'http://test', model: 'test' }),
        modelStream: async function* (_config, system): AsyncGenerator<ChatChunk> {
          systemPrompts.push(system);
          yield { content: 'ok', done: false };
          yield { content: null, done: true };
        },
      });
      await runtime.whenReady();
      await runtime.openSession('no-context');
      await runtime.submitMessage('no-context', 'hello');
      await runtime.waitForIdle('no-context');
      await runtime.shutdown();

      assert.ok(systemPrompts.length > 0, 'model was not called');
      assert.equal(systemPrompts.some((system) => system.includes('Project context (AGENTS.md):')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('asides fold into the next submitted message for the model and persist', async () => {
    const delivered: string[] = [];
    const { runtime, root, store } = await fixture(async function* (_config, _system, messages: AgentModelMessage[]): AsyncGenerator<ChatChunk> {
      delivered.push(String(messages.at(-1)?.content ?? ''));
      yield { content: 'ok', done: true };
    });
    try {
      await assert.rejects(runtime.addAside('asides', '   '), /Aside cannot be empty/);
      const queued = await runtime.addAside('asides', 'Run npm test before committing');
      assert.equal(queued.queued, true);
      await runtime.submitMessage('asides', 'please continue');
      await runtime.waitForIdle('asides');
      // The model must see the folded aside, not just the raw user text.
      assert.match(delivered.at(-1) ?? '', /Run npm test before committing/);
      assert.match(delivered.at(-1) ?? '', /please continue/);
      // The persisted user message carries the aside inline; the queue is empty.
      const persisted = (await store.load('asides'))!.session;
      const userMessage = persisted.messages.find((message) => message.role === 'user');
      assert.ok(userMessage?.content.includes('Run npm test before committing'));
      assert.equal(persisted.pendingAsides?.length ?? 0, 0, 'asides clear after folding');
      // A queued aside survives a persist round trip.
      await runtime.addAside('asides', 'second note');
      assert.deepEqual((await store.load('asides'))!.session.pendingAsides, ['second note']);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('setSessionGoal injects the goal into agent prompts until cleared', async () => {
    const prompts: string[] = [];
    const { runtime, root, store } = await fixture(async function* (_config, system): AsyncGenerator<ChatChunk> {
      prompts.push(system);
      yield { content: 'ok', done: true };
    });
    try {
      const set = await runtime.setSessionGoal('goaled', 'Finish the migration without touching the public API');
      assert.equal(set.set, true);
      await runtime.submitMessage('goaled', 'go');
      await runtime.waitForIdle('goaled');
      assert.ok(prompts.some((prompt) => prompt.includes('Standing goal for this session') && prompt.includes('Finish the migration without touching the public API')));
      assert.equal((await store.load('goaled'))!.session.goal, 'Finish the migration without touching the public API');
      const cleared = await runtime.setSessionGoal('goaled', '');
      assert.equal(cleared.set, false);
      assert.equal(runtime.getSession('goaled')?.goal, undefined);
      prompts.length = 0;
      await runtime.submitMessage('goaled', 'again');
      await runtime.waitForIdle('goaled');
      assert.ok(prompts.length > 0, 'model was not called after clearing');
      assert.ok(prompts.every((prompt) => !prompt.includes('Standing goal for this session')));
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
