import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, saveSelectedModel } from '../src/config.js';
import type { AgentConfig } from '../src/config.js';

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

  it('round-trips providers and provider-referencing model aliases', async () => {
    const cwd = process.cwd();
    const dir = await mkdtemp(join(tmpdir(), 'coder-config-providers-'));
    const path = join(dir, '.agentrc');
    const previousConfigHome = process.env.CODER_CONFIG_HOME;
    process.chdir(dir);
    process.env.CODER_CONFIG_HOME = dir;
    try {
    await writeFile(path, JSON.stringify({
      model: 'fast',
      providers: {
        openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test' },
      },
      models: {
        fast: { provider: 'openrouter', model: 'meta/llama-3' },
        slow: { provider: 'openrouter', model: 'anthropic/claude' },
      },
    }), 'utf8');
    const config = await loadConfig();
    assert.deepEqual(config.providers?.openrouter, { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test' });
    assert.deepEqual(config.models?.fast, { provider: 'openrouter', model: 'meta/llama-3' });
    // A legacy flat alias is migrated into a synthesized provider, and two
    // aliases sharing one endpoint dedupe onto the same provider entry.
    await writeFile(path, JSON.stringify({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'sk-gw',
      backend: 'openai',
      models: {
        remote: { model: 'Kimi', baseUrl: 'https://gateway.example/v1', apiKey: 'sk-gw', backend: 'openai' },
        other: { model: 'Qwen', baseUrl: 'https://gateway.example/v1', backend: 'openai' },
      },
    }), 'utf8');
    const migrated = await loadConfig();
    assert.equal(Object.keys(migrated.models ?? {}).length, 2);
    for (const entry of Object.values(migrated.models ?? {})) {
      assert.ok(entry.provider, 'a legacy alias must be repointed at a synthesized provider');
      assert.equal(entry.baseUrl, undefined);
      assert.equal(entry.apiKey, undefined);
    }
    const providerNames = new Set(Object.values(migrated.models ?? {}).map((entry) => entry.provider));
    assert.equal(providerNames.size, 1, 'aliases sharing one endpoint must share one provider');
    const provider = migrated.providers?.[[...providerNames][0]!];
    assert.equal(provider?.baseUrl, 'https://gateway.example/v1');
    assert.equal(provider?.apiKey, 'sk-gw');
    } finally {
      process.chdir(cwd);
      if (previousConfigHome === undefined) delete process.env.CODER_CONFIG_HOME;
      else process.env.CODER_CONFIG_HOME = previousConfigHome;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
