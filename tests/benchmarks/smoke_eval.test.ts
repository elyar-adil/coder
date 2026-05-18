import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('benchmark catalog exists and lists mainstream coding benchmarks', async () => {
  const raw = await readFile('tests/benchmarks/benchmark_catalog.json', 'utf8');
  const obj = JSON.parse(raw) as { benchmarks: Array<{ name: string }> };
  const names = obj.benchmarks.map((b) => b.name);
  for (const required of ['SWE-bench Lite', 'HumanEval', 'MBPP', 'APPS', 'LiveCodeBench']) {
    assert.ok(names.includes(required), `missing ${required}`);
  }
});
