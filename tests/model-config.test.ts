import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelConfig } from '../src/model-config.js';

describe('resolveModelConfig', () => {
  it('uses alias-specific backend settings from config', () => {
    const resolved = resolveModelConfig({
      baseUrl: 'https://default.example/v1',
      backend: 'openai',
      apiKey: 'default-key',
      model: 'remote',
      models: {
        remote: {
          model: 'Kimi',
          baseUrl: 'https://gateway.example/v1',
          backend: 'openai',
          apiKey: 'remote-key',
          contextWindow: 131072,
          requestOptions: {
            maxTokens: 8192,
          },
        },
      },
    });

    assert.equal(resolved.name, 'remote');
    assert.deepEqual(resolved.config, {
      type: 'openai',
      baseUrl: 'https://gateway.example/v1',
      model: 'Kimi',
      apiKey: 'remote-key',
      contextWindow: 131072,
      requestOptions: {
        maxTokens: 8192,
      },
    });
  });

  it('falls back to top-level config when requested model is not an alias', () => {
    const resolved = resolveModelConfig({
      baseUrl: 'https://default.example',
      backend: 'openai',
      apiKey: 'default-key',
    }, 'qwen3.6-flash');

    assert.deepEqual(resolved.config, {
      type: 'openai',
      baseUrl: 'https://default.example',
      model: 'qwen3.6-flash',
      apiKey: 'default-key',
    });
  });

});
