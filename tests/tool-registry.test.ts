import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition, ToolExecutionContext } from '../src/tools/types.js';
import { executeTool, listTools } from '../src/infra/tools.js';
import { defaultPolicy } from '../src/policy.js';
import type { ToolContext } from '../src/domain/task.js';

const definition = (name: string): ToolDefinition => ({
  type: 'function',
  function: {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: {}, required: [] },
  },
});

describe('ToolRegistry', () => {
  test('registers, describes and executes provider-neutral tools', async () => {
    const registry = new ToolRegistry<ToolExecutionContext>();
    registry.register({
      definition: definition('hello'),
      metadata: { effect: 'read', category: 'agent' },
      execute: async (args) => `hello ${String(args['name'])}`,
    });

    assert.equal(registry.has('hello'), true);
    assert.equal(registry.definitions()[0]?.function.name, 'hello');
    assert.equal(registry.describe()[0]?.metadata.effect, 'read');
    assert.equal(await registry.execute('hello', { name: 'world' }), 'hello world');
  });

  test('rejects duplicate names and normalizes unknown/aborted calls', async () => {
    const registry = new ToolRegistry<ToolExecutionContext>();
    const tool = {
      definition: definition('once'),
      metadata: { effect: 'read' as const, category: 'agent' as const },
      execute: async () => 'ok',
    };
    registry.register(tool);
    assert.throws(() => registry.register(tool), /already registered/);
    assert.equal(await registry.execute('missing', {}), 'Error: unknown tool "missing"');

    const controller = new AbortController();
    controller.abort();
    assert.equal(await registry.execute('once', {}, { signal: controller.signal }), 'Error: tool execution aborted');
  });
});

describe('built-in tool runtime', () => {
  let workspace = '';
  let outside = '';
  let context: ToolContext;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'coder-toolkit-workspace-'));
    outside = await mkdtemp(join(tmpdir(), 'coder-toolkit-outside-'));
    await writeFile(join(workspace, 'one.txt'), 'alpha\nbeta\ngamma', 'utf8');
    await writeFile(join(workspace, 'two.txt'), 'delta', 'utf8');
    context = {
      workspaceRoot: workspace,
      policy: defaultPolicy('moderate', workspace),
      spawnSubagent: async () => 'subagent',
      collectSubagent: async () => 'result',
    };
  });

  after(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test('exposes a categorized, non-duplicated built-in catalog', () => {
    const tools = listTools();
    const names = tools.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes('read_files'));
    assert.ok(names.includes('file_info'));
    assert.ok(names.includes('git_log'));
    assert.ok(tools.every((tool) => tool.metadata.effect && tool.metadata.category));
  });

  test('batch reads relative to the injected workspace and isolates failures', async () => {
    const result = await executeTool('read_files', {
      paths: ['one.txt', 'missing.txt', 'two.txt'],
      max_lines: 2,
    }, context);
    assert.match(result, /===== one\.txt =====/);
    assert.match(result, /00001\|alpha/);
    assert.match(result, /showing lines 1-2 of 3/);
    assert.match(result, /===== missing\.txt =====[\s\S]*Error reading file/);
    assert.match(result, /===== two\.txt =====[\s\S]*00001\|delta/);
  });

  test('returns file metadata without content and blocks paths outside the workspace', async () => {
    const result = JSON.parse(await executeTool('file_info', { path: 'one.txt' }, context)) as Record<string, unknown>;
    assert.equal(result['ok'], true);
    assert.equal(result['type'], 'file');
    assert.equal(result['size'], 16);

    const blocked = await executeTool('file_info', { path: join(outside, 'secret.txt') }, context);
    assert.match(blocked, /PolicyError/);
  });

  test('blocks shell working directories outside the workspace', async () => {
    const blocked = await executeTool('bash', { command: 'echo unsafe', cwd: outside }, context);
    assert.match(blocked, /cwd_outside_workspace/);
  });
});
