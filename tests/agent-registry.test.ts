import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRegistry, matchesAgentSelector, parseAgentSpec } from '../src/runtime/agent-registry.js';

const spec = (description: string, agents = '[]'): string => `---
description: ${description}
model: inherit
tools: [read_file]
agents: ${agents}
---

Follow this spec.
`;

describe('AgentRegistry', () => {
  test('parses frontmatter and selector forms', () => {
    const parsed = parseAgentSpec(spec('Main agent', '[coordinator, review/*]'), 'main.md', 'main', 'builtin');
    assert.equal(parsed.description, 'Main agent');
    assert.deepEqual(parsed.tools, ['read_file']);
    assert.deepEqual(parsed.agents, ['coordinator', 'review/*']);
    assert.equal(matchesAgentSelector('review/security', 'review/*'), true);
    assert.equal(matchesAgentSelector('review', 'review/*'), false);
    assert.equal(matchesAgentSelector('anything', '*'), true);
  });

  test('loads built-in, user, and project specs with project precedence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coder-agent-registry-'));
    const builtin = join(root, 'builtin');
    const user = join(root, 'user');
    const project = join(root, 'project');
    try {
      await Promise.all([mkdir(builtin), mkdir(user), mkdir(project)]);
      await writeFile(join(builtin, 'main.md'), spec('Built-in main', '[coordinator, review/*]'));
      await writeFile(join(builtin, 'coordinator.md'), spec('Built-in coordinator', '[*]'));
      await mkdir(join(builtin, 'review'));
      await writeFile(join(builtin, 'review', 'security.md'), spec('Security review'));
      await writeFile(join(user, 'coordinator.md'), spec('User coordinator', '[*]'));
      await writeFile(join(project, 'coordinator.md'), spec('Project coordinator', '[review/*]'));

      const registry = new AgentRegistry({ builtinDir: builtin, userDir: user, projectDir: project });
      await registry.load();

      assert.equal(registry.get('coordinator')?.description, 'Project coordinator');
      assert.equal(registry.get('coordinator')?.scope, 'project');
      assert.deepEqual(registry.allowedAgents('main').map((item) => item.id), ['coordinator', 'review/security']);
      assert.equal(registry.canCall('coordinator', 'review/security'), true);
      assert.equal(registry.canCall('coordinator', 'main'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects invalid specs instead of silently falling back', () => {
    assert.throws(() => parseAgentSpec('No frontmatter', 'bad.md', 'bad', 'project'), /frontmatter/);
    assert.throws(() => parseAgentSpec('---\ntools: []\n---\nBody', 'bad.md', 'bad', 'project'), /description/);
  });
});

