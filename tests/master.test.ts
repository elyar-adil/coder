import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterCoordinator, parsePlan, parseOllamaNdjson } from '../src/master.js';

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('MasterCoordinator', () => {
  let master: MasterCoordinator;

  before(() => {
    master = new MasterCoordinator('http://localhost:11434', 'test-model');
  });

  describe('acceptPrompt and getTask', () => {
    test('acceptPrompt returns a taskId', async () => {
      const taskId = await master.acceptPrompt('user1', 'hello', 'build');
      assert.ok(typeof taskId === 'string');
      assert.ok(taskId.length > 0);
    });

    test('getTask returns the created task', async () => {
      const taskId = await master.acceptPrompt('user2', 'test task', 'plan');
      const task = master.getTask(taskId);
      assert.ok(task);
      assert.equal(task!.taskId, taskId);
      assert.equal(task!.userId, 'user2');
      assert.equal(task!.prompt, 'test task');
      assert.equal(task!.mode, 'plan');
    });

    test('getTask returns undefined for missing task', () => {
      const task = master.getTask('nonexistent-id');
      assert.equal(task, undefined);
    });

    test('acceptPrompt sets initial status to queued', async () => {
      const taskId = await master.acceptPrompt('user3', 'prompt', 'build');
      const task = master.getTask(taskId);
      assert.equal(task!.status, 'queued');
    });
  });

  describe('listTasks', () => {
    test('returns all tasks', async () => {
      const count = master.listTasks().length;
      await master.acceptPrompt('u1', 't1', 'build');
      await master.acceptPrompt('u2', 't2', 'build');
      assert.equal(master.listTasks().length, count + 2);
    });

    test('returns empty array initially', () => {
      const fresh = new MasterCoordinator('http://localhost:11434', 'm');
      assert.equal(fresh.listTasks().length, 0);
    });

    test('filters tasks by session id', async () => {
      const fresh = new MasterCoordinator('http://localhost:11434', 'm');
      const s1 = await fresh.acceptPrompt('u1', 'session one task', 'build', [], { sessionId: 's1' });
      const s2 = await fresh.acceptPrompt('u2', 'session two task', 'build', [], { sessionId: 's2' });

      assert.deepEqual(fresh.listTasks({ sessionId: 's1' }).map((task) => task.taskId), [s1]);
      assert.deepEqual(fresh.listTasks({ sessionId: 's2' }).map((task) => task.taskId), [s2]);
    });

    test('attaches artifact directory context to accepted tasks', async () => {
      const fresh = new MasterCoordinator('http://localhost:11434', 'm');
      const artifactDir = join(tmpdir(), 'coder-session-artifacts');
      const taskId = await fresh.acceptPrompt('u1', 'generate a ppt', 'build', [], { sessionId: 's1', artifactDir });
      const task = fresh.getTask(taskId);

      assert.equal(task?.artifactDir, artifactDir);
      assert.match(task?.sharedContext ?? '', /Artifact workspace/);
      assert.match(task?.sharedContext ?? '', new RegExp(artifactDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  });

  describe('LLM tracing', () => {
    async function withMockBackend(
      fn: (baseUrl: string) => Promise<void>,
    ): Promise<void> {
      const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => {
          raw += String(chunk);
        });
        req.on('end', () => {
          const body = JSON.parse(raw) as { messages?: Array<{ role?: string; content?: string }> };
          const system = body.messages?.[0]?.content ?? '';
          let content = 'mock answer';
          let toolCalls: unknown;
          const userContent = body.messages?.map((message) => message.content ?? '').join('\n') ?? '';
          const hasToolResult = body.messages?.some((message) => message.role === 'tool') ?? false;
          if (system.includes('master router')) {
            const taskIds = [...userContent.matchAll(/"taskId":\s*"([^"]+)"/g)].map((match) => match[1]);
            const targetTaskIds = taskIds[0] ? [taskIds[0]] : [];
            const action = userContent.includes('red theme')
              ? 'update_task'
              : userContent.includes('how is the ppt')
                ? 'query_task'
                : userContent.includes('html')
                  ? 'derived_task'
                  : 'new_task';
            content = JSON.stringify({
              action,
              targetTaskIds: action === 'new_task' ? [] : targetTaskIds,
              reason: 'mock route',
              prompt: userContent.includes('red theme') ? 'Use a red theme for the PPT.' : 'mock routed prompt',
            });
          } else if (system.includes('master coordinator answering')) {
            content = 'The referenced task is in progress.';
          } else if (system.includes('senior planner agent')) {
            if (userContent.includes('123456789')) {
              content = JSON.stringify({
                summary: 'calculate sum',
                mode: 'analyze',
                readOnly: true,
                steps: [{
                  title: 'Calculate exact sum',
                  detail: 'Use bash for exact arithmetic.',
                  intent: 'tool_loop',
                  toolPolicy: 'safe',
                  instruction: 'Use bash to calculate 123456789+99999999 and answer with the result.',
                }],
                questions: [],
              });
            } else {
              content = JSON.stringify({
                summary: 'mock summary',
                mode: 'analyze',
                readOnly: true,
                steps: [{
                  title: 'Answer request',
                  detail: 'Answer directly.',
                  intent: 'answer',
                  toolPolicy: 'none',
                  instruction: 'Answer directly.',
                }],
                questions: [],
              });
            }
          } else if (system.includes('execute one planner step')) {
            if (hasToolResult) {
              content = '223456788';
            } else {
              content = '';
              toolCalls = [{
                id: 'call_calc',
                function: {
                  name: 'bash',
                  arguments: { command: 'node -e "console.log(123456789+99999999)"' },
                },
              }];
            }
          }
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.end(`${JSON.stringify({ message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } })}\n${JSON.stringify({ done: true })}\n`);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      try {
        await fn(`http://127.0.0.1:${address.port}`);
      } finally {
        await new Promise<void>((resolve, reject) => {
          (server as Server).close((error) => error ? reject(error) : resolve());
        });
      }
    }

    test('does not collect raw LLM traces by default', async () => {
      await withMockBackend(async (baseUrl) => {
        const coordinator = new MasterCoordinator({ type: 'ollama', baseUrl, model: 'mock' });
        let taskId = '';
        for await (const chunk of coordinator.streamPrompt('u', 'hello', 'build')) {
          if (chunk.type === 'task_id') taskId = chunk.taskId;
        }
        assert.equal(coordinator.getTask(taskId)?.llmTrace, undefined);
      });
    });

    test('collects raw LLM traces when enabled', async () => {
      await withMockBackend(async (baseUrl) => {
        const coordinator = new MasterCoordinator({ type: 'ollama', baseUrl, model: 'mock' });
        coordinator.setLlmTracingEnabled(true);
        let taskId = '';
        for await (const chunk of coordinator.streamPrompt('u', 'hello', 'build')) {
          if (chunk.type === 'task_id') taskId = chunk.taskId;
        }
        const trace = coordinator.getTask(taskId)?.llmTrace ?? [];
        assert.ok(trace.length >= 2);
        const labels = trace.map((entry) => entry.label);
        assert.ok(labels.includes('planner'));
        assert.ok(labels.includes('step_1_answer'));
        assert.ok(trace[0]!.systemPrompt.length > 0);
        assert.equal(trace.find((entry) => entry.label === 'step_1_answer')?.response, 'mock answer');
      });
    });

    test('stores user-visible todos from planner steps', async () => {
      await withMockBackend(async (baseUrl) => {
        const coordinator = new MasterCoordinator({ type: 'ollama', baseUrl, model: 'mock' });
        let taskId = '';
        for await (const chunk of coordinator.streamPrompt('u', 'hello', 'build')) {
          if (chunk.type === 'task_id') taskId = chunk.taskId;
        }
        const task = coordinator.getTask(taskId);
        assert.equal(task?.todos?.length, 1);
        assert.equal(task?.todos?.[0]?.text, 'Answer request');
        assert.equal(task?.todos?.[0]?.status, 'done');
      });
    });

    test('uses planner-selected bash step for arithmetic without design phase', async () => {
      await withMockBackend(async (baseUrl) => {
        const coordinator = new MasterCoordinator({ type: 'ollama', baseUrl, model: 'mock' });
        const chunks = [];
        for await (const chunk of coordinator.streamPrompt('u', '123456789+99999999等于多少', 'build')) {
          chunks.push(chunk);
        }
        const phases = chunks
          .filter((chunk): chunk is Extract<typeof chunk, { type: 'phase' }> => chunk.type === 'phase')
          .map((chunk) => chunk.phase);
        const tools = chunks
          .filter((chunk): chunk is Extract<typeof chunk, { type: 'tool_call' }> => chunk.type === 'tool_call')
          .map((chunk) => chunk.tool);
        const done = chunks.find((chunk): chunk is Extract<typeof chunk, { type: 'done' }> => chunk.type === 'done');
        assert.ok(!phases.includes('design'));
        assert.ok(tools.includes('bash'));
        assert.ok(done?.result.includes('223456788'));
      });
    });

    test('answers task questions from a session inquiry task', async () => {
      await withMockBackend(async (baseUrl) => {
        const coordinator = new MasterCoordinator({ type: 'ollama', baseUrl, model: 'mock' });
        let pptTaskId = '';
        for await (const chunk of coordinator.streamPrompt('u', 'make a ppt about roadmap', 'build')) {
          if (chunk.type === 'task_id') pptTaskId = chunk.taskId;
        }

        const beforeCount = coordinator.listTasks().length;
        let answer = '';
        for await (const chunk of coordinator.streamPrompt('u', 'how is the ppt going?', 'build')) {
          if (chunk.type === 'token') answer += chunk.text;
        }

        assert.equal(coordinator.listTasks().length, beforeCount + 1);
        const inquiry = coordinator.listTasks().find((task) => task.taskId !== pptTaskId);
        assert.equal(inquiry?.kind, 'inquiry');
        assert.ok(answer.includes('in progress'));
        assert.equal(coordinator.getTask(pptTaskId)?.mailbox, undefined);
      });
    });

    test('routes requirement changes into the target task mailbox', async () => {
      await withMockBackend(async (baseUrl) => {
        const coordinator = new MasterCoordinator({ type: 'ollama', baseUrl, model: 'mock' });
        const pptTaskId = await coordinator.acceptPrompt('u', 'make a ppt about launch', 'build');

        let routedTaskId = '';
        for await (const chunk of coordinator.streamPrompt('u', 'change the ppt to a red theme', 'build')) {
          if (chunk.type === 'task_id') routedTaskId = chunk.taskId;
        }

        const target = coordinator.getTask(pptTaskId);
        const routed = coordinator.getTask(routedTaskId);
        assert.equal(routed?.kind, 'inquiry');
        assert.deepEqual(routed?.relatedTaskIds, [pptTaskId]);
        assert.ok(target?.mailbox?.some((message) => message.text.includes('red theme')));
        assert.equal(coordinator.listTasks().filter((task) => task.taskId !== pptTaskId).length, 1);
      });
    });
  });

  describe('patch writer', () => {
    test('applies a patch when the base hash matches', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'coder-writer-test-'));
      try {
        const coordinator = new MasterCoordinator('http://localhost:11434', 'm');
        const taskId = await coordinator.acceptPrompt('u', 'write patch', 'build', [], { sessionId: 'writer' });
        const target = join(dir, 'file.txt');

        const submitPatch = (coordinator as unknown as {
          submitPatch: (taskId: string, input: {
            summary: string;
            files: Array<{ path: string; baseHash?: string; before?: string; after: string }>;
            verificationCommands: string[];
          }) => Promise<string>;
        }).submitPatch.bind(coordinator);

        const result = await submitPatch(taskId, {
          summary: 'create file',
          files: [{ path: target, baseHash: hashContent(''), before: '', after: 'created' }],
          verificationCommands: [],
        });

        assert.match(result, /^WriterApplied:/);
        assert.equal(await readFile(target, 'utf8'), 'created');
        assert.equal(coordinator.getTask(taskId)?.patchSets?.[0]?.status, 'verified');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('reports conflict and leaves file unchanged when base hash differs', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'coder-writer-conflict-'));
      try {
        const coordinator = new MasterCoordinator('http://localhost:11434', 'm');
        const taskId = await coordinator.acceptPrompt('u', 'write patch', 'build', [], { sessionId: 'writer' });
        const target = join(dir, 'file.txt');
        await writeFile(target, 'current', 'utf8');

        const submitPatch = (coordinator as unknown as {
          submitPatch: (taskId: string, input: {
            summary: string;
            files: Array<{ path: string; baseHash?: string; before?: string; after: string }>;
            verificationCommands: string[];
          }) => Promise<string>;
        }).submitPatch.bind(coordinator);

        const result = await submitPatch(taskId, {
          summary: 'conflicting edit',
          files: [{ path: target, baseHash: hashContent('old'), before: 'old', after: 'new' }],
          verificationCommands: [],
        });

        assert.match(result, /^WriterConflict:/);
        assert.equal(await readFile(target, 'utf8'), 'current');
        assert.equal(coordinator.getTask(taskId)?.patchSets?.[0]?.status, 'conflict');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('clarifications', () => {
    test('accepts generated choices and free-form clarification answers', async () => {
      const coordinator = new MasterCoordinator('http://localhost:11434', 'm');
      const taskId = await coordinator.acceptPrompt('u', 'needs a choice', 'build', [], { sessionId: 'clarify' });
      const requestClarification = (coordinator as unknown as {
        requestClarification: (taskId: string, question: string, choices?: string[]) => Promise<string>;
      }).requestClarification.bind(coordinator);

      const pending = requestClarification(taskId, 'Pick an implementation style.', ['Fast path', 'Careful path']);
      const request = coordinator.listPendingClarifications(taskId)[0];
      assert.ok(request);
      assert.deepEqual(request.choices, ['Fast path', 'Careful path']);

      assert.equal(coordinator.answerClarification(taskId, request.clarificationId, 'free-form answer'), true);
      assert.equal(await pending, 'free-form answer');
      assert.equal(coordinator.listPendingClarifications(taskId).length, 0);
    });

    test('adds concrete fallback choices when a clarification has too few options', async () => {
      const coordinator = new MasterCoordinator('http://localhost:11434', 'm');
      const taskId = await coordinator.acceptPrompt('u', 'needs fallback choices', 'build', [], { sessionId: 'clarify' });
      const requestClarification = (coordinator as unknown as {
        requestClarification: (taskId: string, question: string, choices?: string[]) => Promise<string>;
      }).requestClarification.bind(coordinator);

      void requestClarification(taskId, 'Pick a path.', ['Only option']);
      const request = coordinator.listPendingClarifications(taskId)[0];

      assert.ok(request);
      assert.equal(request.choices.length >= 2, true);
      assert.equal(request.choices[0], 'Only option');
    });
  });

  describe('executePlan', () => {
    test('returns false for nonexistent task', async () => {
      const result = await master.executePlan('nope');
      assert.equal(result, false);
    });

    test('returns false for non-plan mode task', async () => {
      const taskId = await master.acceptPrompt('u', 'p', 'build');
      const result = await master.executePlan(taskId);
      assert.equal(result, false);
    });

    test('returns false for plan mode task with empty plan', async () => {
      const taskId = await master.acceptPrompt('u', 'p', 'plan');
      const result = await master.executePlan(taskId);
      assert.equal(result, false);
    });
  });

  describe('resolveTask', () => {
    test('does not bypass routing for a newly accepted queued task', async () => {
      const coordinator = new MasterCoordinator('http://localhost:11434', 'm');
      const taskId = await coordinator.acceptPrompt('u', 'p', 'build', [], { sessionId: 'resume' });

      const accepted = await coordinator.resolveTask(taskId);
      assert.equal(accepted, true);
      assert.equal(coordinator.getTask(taskId)?.status, 'queued');
    });

    test('does not start a second runner for an already running task', async () => {
      const coordinator = new MasterCoordinator('http://localhost:11434', 'm');
      const taskId = await coordinator.acceptPrompt('u', 'p', 'build', [], { sessionId: 'resume' });
      const task = coordinator.getTask(taskId);
      assert.ok(task);
      task!.status = 'running';

      const runningTasks = (coordinator as unknown as { runningTasks: Set<string> }).runningTasks;
      runningTasks.add(taskId);

      const accepted = await coordinator.resolveTask(taskId);
      assert.equal(accepted, true);
      assert.equal(runningTasks.size, 1);
      assert.equal(coordinator.getTask(taskId)?.status, 'running');
    });
  });

  describe('parsePlan', () => {
    test('parses valid JSON array', () => {
      const input = '[{"title":"Step 1","detail":"Do X"},{"title":"Step 2","detail":"Do Y"}]';
      const result = parsePlan(input);
      assert.equal(result.length, 2);
      assert.equal(result[0]!.title, 'Step 1');
      assert.equal(result[0]!.detail, 'Do X');
    });

    test('handles empty array', () => {
      assert.equal(parsePlan('[]').length, 0);
    });

    test('handles missing fields with defaults', () => {
      const result = parsePlan('[{"title":"A"},{"detail":"B"},{}]');
      assert.equal(result[0]!.title, 'A');
      assert.equal(result[0]!.detail, '');
      assert.equal(result[1]!.title, 'step');
      assert.equal(result[1]!.detail, 'B');
      assert.equal(result[2]!.title, 'step');
      assert.equal(result[2]!.detail, '');
    });

    test('strips markdown code fences', () => {
      const result = parsePlan('```json\n[{"title":"A","detail":"B"}]\n```');
      assert.equal(result.length, 1);
    });

    test('strips code fences without language', () => {
      const result = parsePlan('```\n[{"title":"A","detail":"B"}]\n```');
      assert.equal(result.length, 1);
    });

    test('throws on invalid JSON', () => {
      assert.throws(() => parsePlan('not json'), Error);
    });

    test('throws on non-array JSON', () => {
      assert.throws(() => parsePlan('{"title":"A"}'), /expects JSON array/);
    });

    test('handles whitespace padding', () => {
      const result = parsePlan('  \n  [{"title":"A","detail":"B"}]\n  ');
      assert.equal(result.length, 1);
    });
  });

  describe('parseOllamaNdjson', () => {
    test('parses content message', () => {
      const line = '{"message":{"role":"assistant","content":"hello"}}';
      const result = parseOllamaNdjson(line);
      assert.ok(result);
      assert.equal(result!.message?.content, 'hello');
    });

    test('parses tool_calls message', () => {
      const line = '{"message":{"role":"assistant","tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}}]}}';
      const result = parseOllamaNdjson(line);
      assert.ok(result);
      assert.equal(result!.message?.tool_calls?.length, 1);
    });

    test('parses done flag', () => {
      const result = parseOllamaNdjson('{"done":true}');
      assert.ok(result);
      assert.equal(result!.done, true);
    });

    test('returns null for empty line', () => {
      assert.equal(parseOllamaNdjson(''), null);
    });

    test('returns null for whitespace line', () => {
      assert.equal(parseOllamaNdjson('   '), null);
    });

    test('returns null for invalid JSON', () => {
      assert.equal(parseOllamaNdjson('broken{'), null);
    });
  });
});
