import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
