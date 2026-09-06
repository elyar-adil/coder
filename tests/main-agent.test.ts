import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentRegistry } from '../src/runtime/agent-registry.js';
import { AgentRuntime } from '../src/runtime/agent-runtime.js';
import { AgentRuntimeStore } from '../src/runtime/agent-store.js';
import { getToolPolicy, setToolPolicy, toolRegistry } from '../src/infra/tools.js';
import { defaultPolicy } from '../src/policy.js';

test('built-in main retains file creation and verification as fallback capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coder-main-html-'));
  const originalPolicy = getToolPolicy();
  setToolPolicy(defaultPolicy('moderate', root));
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>简历</title><body>姓名：待填写</body></html>';
  let calls = 0;
  const registry = new AgentRegistry({
    builtinDir: resolve(import.meta.dirname, '..', 'agents'),
    userDir: join(root, 'user'), projectDir: join(root, 'project'),
  });
  const runtime = new AgentRuntime({
    registry, workspaceRoot: root, store: new AgentRuntimeStore(root),
    resolveModel: () => ({ type: 'ollama', baseUrl: 'http://test', model: 'test' }),
    modelStream: async function* (_config, _system, messages, tools) {
      const names = tools.map((tool) => tool.function.name);
      assert.ok(names.includes('write_file'));
      assert.ok(names.includes('read_file'));
      for (const definition of toolRegistry.definitions()) {
        assert.ok(names.includes(definition.function.name), `main can use ${definition.function.name}`);
      }
      calls++;
      if (calls === 1) {
        yield { content: null, toolCalls: [{ id: 'write', function: { name: 'write_file', arguments: { path: 'resume.html', content: html } } }], done: false };
      } else if (calls === 2) {
        assert.match(String(messages.at(-1)?.content), /OK: wrote/);
        yield { content: null, toolCalls: [{ id: 'verify', function: { name: 'read_file', arguments: { path: 'resume.html' } } }], done: false };
      } else {
        assert.match(String(messages.at(-1)?.content), /姓名：待填写/);
        yield { content: '已创建并检查 resume.html。', done: true };
      }
    },
  });
  try {
    await runtime.submitMessage('resume', '帮我用html写一个简历，保存成一个html文件。');
    await runtime.waitForIdle('resume');
    assert.equal(await readFile(join(root, 'resume.html'), 'utf8'), html);
    assert.equal(runtime.listInstances('resume').length, 1);
    assert.equal(runtime.listInstances('resume')[0]!.status, 'idle');
    assert.equal(calls, 3);
  } finally {
    await runtime.shutdown();
    setToolPolicy(originalPolicy);
    await rm(root, { recursive: true, force: true });
  }
});
