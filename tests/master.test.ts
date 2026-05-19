import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { MasterCoordinator, parsePlan, parseOllamaNdjson } from '../src/master.js';

describe('MasterCoordinator', () => {
  let master: MasterCoordinator;

  before(() => {
    master = new MasterCoordinator('http://localhost:11434', 'test-model');
  });

  describe('acceptPrompt and getTask', () => {
    test('acceptPrompt returns a taskId', async () => {
      const taskId = await master.acceptPrompt('user1', 'hello', 'execute');
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
      const taskId = await master.acceptPrompt('user3', 'prompt', 'execute');
      const task = master.getTask(taskId);
      assert.equal(task!.status, 'queued');
    });
  });

  describe('listTasks', () => {
    test('returns all tasks', async () => {
      const count = master.listTasks().length;
      await master.acceptPrompt('u1', 't1', 'execute');
      await master.acceptPrompt('u2', 't2', 'react');
      assert.equal(master.listTasks().length, count + 2);
    });

    test('returns empty array initially', () => {
      const fresh = new MasterCoordinator('http://localhost:11434', 'm');
      assert.equal(fresh.listTasks().length, 0);
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
          if (system.includes('senior planner agent')) {
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
        for await (const chunk of coordinator.streamPrompt('u', 'hello', 'execute')) {
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
        for await (const chunk of coordinator.streamPrompt('u', 'hello', 'execute')) {
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

    test('uses planner-selected bash step for arithmetic without design phase', async () => {
      await withMockBackend(async (baseUrl) => {
        const coordinator = new MasterCoordinator({ type: 'ollama', baseUrl, model: 'mock' });
        const chunks = [];
        for await (const chunk of coordinator.streamPrompt('u', '123456789+99999999等于多少', 'execute')) {
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
  });

  describe('executePlan', () => {
    test('returns false for nonexistent task', async () => {
      const result = await master.executePlan('nope');
      assert.equal(result, false);
    });

    test('returns false for non-plan mode task', async () => {
      const taskId = await master.acceptPrompt('u', 'p', 'execute');
      const result = await master.executePlan(taskId);
      assert.equal(result, false);
    });

    test('returns false for plan mode task with empty plan', async () => {
      const taskId = await master.acceptPrompt('u', 'p', 'plan');
      const result = await master.executePlan(taskId);
      assert.equal(result, false);
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
