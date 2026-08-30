import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, saveSelectedModel } from '../src/config.js';

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
  });

  it('persists selected model to the user-scoped .agentrc file', async () => {
    const cwd = process.cwd();
    const dir = await mkdtemp(join(tmpdir(), 'coder-config-'));
    const previousConfigHome = process.env.CODER_CONFIG_HOME;
    process.chdir(dir);
    process.env.CODER_CONFIG_HOME = dir;

    try {
      const path = await saveSelectedModel('gemmaLocal');
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as { model?: string };
      assert.equal(parsed.model, 'gemmaLocal');
    } finally {
      process.chdir(cwd);
      if (previousConfigHome === undefined) delete process.env.CODER_CONFIG_HOME;
      else process.env.CODER_CONFIG_HOME = previousConfigHome;
    }
  });

  it('persists model aliases and artifact directory', async () => {
    const cwd = process.cwd();
    const dir = await mkdtemp(join(tmpdir(), 'coder-config-models-'));
    const previousConfigHome = process.env.CODER_CONFIG_HOME;
    process.chdir(dir);
    process.env.CODER_CONFIG_HOME = dir;

    try {
      const path = await saveConfig({
        model: 'fast',
        artifactsDir: '.agent-workspace/artifacts',
        models: {
          fast: {
            backend: 'openai',
            model: 'gpt-test',
            contextWindow: 128000,
            requestOptions: { temperature: 0.2 },
          },
        },
      });
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as {
        model?: string;
        artifactsDir?: string;
        models?: { fast?: { model?: string; requestOptions?: { temperature?: number } } };
      };
      assert.equal(parsed.model, 'fast');
      assert.equal(parsed.artifactsDir, '.agent-workspace/artifacts');
      assert.equal(parsed.models?.fast?.model, 'gpt-test');
      assert.equal(parsed.models?.fast?.requestOptions?.temperature, 0.2);
    } finally {
      process.chdir(cwd);
      if (previousConfigHome === undefined) delete process.env.CODER_CONFIG_HOME;
      else process.env.CODER_CONFIG_HOME = previousConfigHome;
    }
  });
});
