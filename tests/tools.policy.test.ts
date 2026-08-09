import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { executeTool, setToolPolicy } from '../src/infra/tools.js';
import { defaultPolicy } from '../src/policy.js';

describe('tool policy', () => {
  test('blocks path traversal outside workspace', async () => {
    setToolPolicy(defaultPolicy('strict', process.cwd()));
    const result = await executeTool('read_file', { path: '../etc/passwd' });
    assert.match(result, /PolicyError/);
  });

  test('blocks dangerous bash command', async () => {
    setToolPolicy(defaultPolicy('strict', process.cwd()));
    const result = await executeTool('bash', { command: 'rm -rf /' });
    assert.match(result, /PolicyError/);
  });

  test('blocks edit_file writes outside the workspace', async () => {
    setToolPolicy(defaultPolicy('strict', process.cwd()));
    const result = await executeTool('edit_file', {
      path: '/tmp/coder-policy-outside.txt',
      edits: JSON.stringify([{ search: 'old', replace: 'new' }]),
    });
    assert.match(result, /PolicyError/);
  });

  test('allows safe allowlisted command in strict mode', async () => {
    setToolPolicy(defaultPolicy('strict', process.cwd()));
    const result = await executeTool('bash', { command: 'npm test -- --help' });
    assert.ok(typeof result === 'string');
  });
});
