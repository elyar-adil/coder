import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

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
    assert.ok(config.backend === undefined || ['ollama', 'openai'].includes(config.backend));
    assert.ok(config.apiKey === undefined || typeof config.apiKey === 'string');
    assert.ok(config.defaultMode === undefined || ['execute', 'plan', 'react'].includes(config.defaultMode));
  });
});
