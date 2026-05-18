import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTasks, runEvalSuite, summarize } from './harness.js';

test('eval harness runs isolated repo tasks and all sample tasks pass', async () => {
  const tasks = await loadTasks('tests/benchmarks/tasks.sample.json');
  const results = await runEvalSuite(tasks);
  const summary = summarize(results);
  assert.equal(summary.total, tasks.length);
  assert.equal(summary.passed, tasks.length);
});
