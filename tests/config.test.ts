import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveSelectedModel } from '../src/config.js';

describe('loadConfig', () => {
  it('returns empty config when no .agentrc exists', async () => {
    const config = await loadConfig();
    // No .agentrc in the project or home dir (expected in test env)
    assert.ok(typeof config === 'object');
  });

  it('returns object with expected optional fields', async () => {
    const config = await loadConfig();
    assert.ok(config.baseUrl === undefined || typeof config.baseUrl === 'string');
    assert.ok(config.model === undefined || typeof config.model === 'string');
    assert.ok(config.backend === undefined || ['ollama', 'openai', 'anthropic'].includes(config.backend));
    assert.ok(config.apiKey === undefined || typeof config.apiKey === 'string');
    assert.ok(config.defaultMode === undefined || ['execute', 'plan', 'react'].includes(config.defaultMode));
  });

  it('persists selected model to the cwd .agentrc file', async () => {
    const cwd = process.cwd();
    const dir = await mkdtemp(join(tmpdir(), 'coder-config-'));
    process.chdir(dir);

    try {
      const path = await saveSelectedModel('gemmaLocal');
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as { model?: string };
      assert.equal(parsed.model, 'gemmaLocal');
    } finally {
      process.chdir(cwd);
    }
  });
});
