import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { AgentEvent, AgentInstance } from '../src/domain/agent.js';
import { TraceRecorder, toolSucceeded, type TraceEvent } from '../src/runtime/trace.js';
import { formatTraceSummary, listTraceSessions, loadTrace, parseTrace, summarizeTrace } from '../src/runtime/trace-report.js';

const instance = (over: Partial<AgentInstance> = {}): AgentInstance => ({
  instanceId: 'i1', sessionId: 's1', agentId: 'main', depth: 0, status: 'idle', messages: [], mailbox: [], childInstanceIds: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
});

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'maw-trace-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('toolSucceeded', () => {
  test('recognizes the failure conventions tools use', () => {
    for (const bad of ['Error: x', 'Error reading file: y', 'PolicyError: tool=bash; rule=r', '  Error: padded', '{"ok":false,"error":"nope"}']) assert.equal(toolSucceeded(bad), false, bad);
    for (const good of ['OK: wrote a.txt', '00001|Error is a word in this line', '(no output)', '{"ok":true}', '']) assert.equal(toolSucceeded(good), true, good);
  });
});

describe('TraceRecorder', () => {
  test('pairs tool start and finish into one record with duration and outcome', async () => {
    await withDir(async (dir) => {
      let now = 1_000;
      const recorder = new TraceRecorder({ dir, now: () => now });
      const events: AgentEvent[] = [
        { type: 'instance_created', instance: instance() },
        { type: 'user_message', sessionId: 's1', message: { messageId: 'm', role: 'user', content: 'fix the bug', createdAt: '' } },
        { type: 'turn_progress', sessionId: 's1', instanceId: 'i1', turnId: 't1', step: 1 },
        { type: 'tool_started', instanceId: 'i1', turnId: 't1', tool: 'bash', input: '{"command":"npm test"}' },
      ];
      for (const event of events) recorder.record(event);
      now = 3_500;
      recorder.record({ type: 'tool_finished', instanceId: 'i1', turnId: 't1', tool: 'bash', output: 'Error: command failed (exit code 1)\nFAIL' });
      await recorder.flush();
      const lines = parseTrace(await readFile(join(dir, 's1.jsonl'), 'utf8'));
      assert.deepEqual(lines.map((line) => line.ev), ['user', 'step', 'tool']);
      const tool = lines[2] as Extract<TraceEvent, { ev: 'tool' }>;
      assert.deepEqual({ tool: tool.tool, ms: tool.ms, ok: tool.ok }, { tool: 'bash', ms: 2_500, ok: false });
      assert.equal(tool.input, '{"command":"npm test"}');
    });
  });

  test('records a turn once when it ends during this run, and ignores turns carried over from earlier runs', async () => {
    await withDir(async (dir) => {
      const recorder = new TraceRecorder({ dir, now: () => Date.parse('2026-06-01T00:00:10.000Z') });
      const old = instance({ lastTurn: { startedAt: '2026-05-01T00:00:00.000Z', endedAt: '2026-05-01T00:00:05.000Z', durationMs: 5000 } });
      recorder.record({ type: 'instance_updated', instance: old });
      const fresh = instance({ lastTurn: { startedAt: '2026-06-01T00:00:11.000Z', endedAt: '2026-06-01T00:00:15.000Z', durationMs: 4000, usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 } } });
      recorder.record({ type: 'instance_updated', instance: fresh });
      recorder.record({ type: 'instance_updated', instance: fresh });
      await recorder.flush();
      const turns = parseTrace(await readFile(join(dir, 's1.jsonl'), 'utf8')).filter((line) => line.ev === 'turn') as Array<Extract<TraceEvent, { ev: 'turn' }>>;
      assert.equal(turns.length, 1);
      assert.deepEqual({ ms: turns[0]!.ms, input: turns[0]!.input, cached: turns[0]!.cached }, { ms: 4000, input: 100, cached: 60 });
    });
  });

  test('redacts every line and clips long tool output', async () => {
    await withDir(async (dir) => {
      const recorder = new TraceRecorder({ dir, redact: (line) => line.split('SECRET-VALUE-123').join('[REDACTED]') });
      recorder.record({ type: 'instance_created', instance: instance() });
      recorder.record({ type: 'tool_started', instanceId: 'i1', turnId: 't', tool: 'bash', input: '{}' });
      recorder.record({ type: 'tool_finished', instanceId: 'i1', turnId: 't', tool: 'bash', output: `key SECRET-VALUE-123 ${'x'.repeat(5000)}` });
      await recorder.flush();
      const text = await readFile(join(dir, 's1.jsonl'), 'utf8');
      assert.doesNotMatch(text, /SECRET-VALUE-123/);
      const tool = parseTrace(text)[0] as Extract<TraceEvent, { ev: 'tool' }>;
      assert.ok(tool.output.length <= 401);
      assert.ok(tool.chars > 5000, 'the real size is still recorded');
    });
  });

  test('a recorder that cannot write never throws', async () => {
    await withDir(async (dir) => {
      const blocker = join(dir, 'a-file');
      await writeFile(blocker, 'not a directory');
      // The trace directory would have to live inside a regular file, so mkdir fails with ENOTDIR.
      const recorder = new TraceRecorder({ dir: join(blocker, 'traces') });
      recorder.record({ type: 'user_message', sessionId: 's', message: { messageId: 'm', role: 'user', content: 'x', createdAt: '' } });
      await assert.doesNotReject(recorder.flush());
    });
  });
});

describe('summarizeTrace', () => {
  const t = (n: number): number => 1_700_000_000_000 + n * 1000;
  const tool = (tool: string, ms: number, ok: boolean, output = 'OK'): TraceEvent => ({ t: t(1), ev: 'tool', session: 's', instance: 'i', turn: 't1', tool, ms, ok, input: '{}', output, chars: output.length });
  const events: TraceEvent[] = [
    { t: t(0), ev: 'user', session: 's', text: 'go' },
    { t: t(1), ev: 'step', session: 's', instance: 'i', turn: 't1', step: 1 },
    { t: t(2), ev: 'step', session: 's', instance: 'i', turn: 't1', step: 2 },
    { t: t(3), ev: 'step', session: 's', instance: 'i', turn: 't1', step: 3 },
    { t: t(4), ev: 'step', session: 's', instance: 'i', turn: 't2', step: 1 },
    tool('read_file', 100, true),
    tool('read_file', 300, false, 'Error reading file: ENOENT: no such file or directory, open \'/tmp/a/one.ts\''),
    tool('read_file', 200, false, 'Error reading file: ENOENT: no such file or directory, open \'/tmp/b/two.ts\''),
    tool('bash', 5000, false, 'Error: command timed out after 60000ms and was killed'),
    { t: t(9), ev: 'turn', session: 's', instance: 'i', agent: 'main', status: 'idle', ms: 8000, input: 1000, output: 100, cached: 400 },
    { t: t(10), ev: 'turn', session: 's', instance: 'i', agent: 'main', status: 'failed', ms: 2000, input: 500, output: 50, error: 'boom' },
    { t: t(11), ev: 'compact', session: 's', instance: 'i', reason: 'auto', before: 90, after: 30, archived: 6 },
    { t: t(12), ev: 'system', session: 's', text: 'Run paused: the same read_file call repeated' },
    { t: t(13), ev: 'system', session: 's', text: 'Session goal set: x' },
    { t: t(14), ev: 'error', error: 'stream died' },
  ];

  test('aggregates tools, turns, requests, tokens, and notices', () => {
    const summary = summarizeTrace('s', events);
    assert.equal(summary.userMessages, 1);
    assert.deepEqual(summary.turns, { count: 2, totalMs: 10_000, maxMs: 8000, failed: 1 });
    assert.deepEqual(summary.requests, { total: 4, maxInOneTurn: 3 });
    assert.deepEqual(summary.tokens, { input: 1500, output: 150, cached: 400, reasoning: 0 });
    assert.equal(summary.compactions, 1);
    assert.deepEqual(summary.notices, ['Run paused: the same read_file call repeated']);
    assert.deepEqual(summary.runtimeErrors, ['stream died']);
    const read = summary.tools.find((entry) => entry.tool === 'read_file')!;
    assert.deepEqual({ calls: read.calls, errors: read.errors, totalMs: read.totalMs, maxMs: read.maxMs }, { calls: 3, errors: 2, totalMs: 600, maxMs: 300 });
    assert.equal(summary.tools[0]!.tool, 'read_file', 'most-called first');
  });

  test('groups the same failure across different paths and numbers', () => {
    const top = summarizeTrace('s', events).topErrors;
    const enoent = top.find((entry) => entry.tool === 'read_file')!;
    assert.equal(enoent.count, 2);
    assert.match(enoent.message, /<path>/);
  });

  test('the report names the failing tools and the loop notice', () => {
    const text = formatTraceSummary(summarizeTrace('s', events));
    assert.match(text, /turns: 2 \(1 failed\)/);
    assert.match(text, /model requests: 4 \(max 3 in one turn\)/);
    assert.match(text, /cached 400, 27%/);
    assert.match(text, /2x read_file: Error reading file/);
    assert.match(text, /Run paused/);
  });

  test('an empty or half-written trace is summarized without error', () => {
    assert.equal(summarizeTrace('s', []).turns.count, 0);
    assert.equal(parseTrace('{"t":1,"ev":"user","session":"s","text":"a"}\n{"t":2,"ev":"us').length, 1);
  });
});

describe('trace files', () => {
  test('lists sessions and loads one by id', async () => {
    await withDir(async (dir) => {
      const recorder = new TraceRecorder({ dir });
      recorder.record({ type: 'user_message', sessionId: 'run-1', message: { messageId: 'm', role: 'user', content: 'a', createdAt: '' } });
      recorder.record({ type: 'user_message', sessionId: 'run-2', message: { messageId: 'm', role: 'user', content: 'b', createdAt: '' } });
      await recorder.flush();
      assert.deepEqual(await listTraceSessions(dir), ['run-1', 'run-2']);
      assert.equal((await loadTrace(dir, 'run-2'))?.length, 1);
      assert.equal(await loadTrace(dir, 'missing'), undefined);
      assert.deepEqual(await listTraceSessions(join(dir, 'nope')), []);
    });
  });
});
