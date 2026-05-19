import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectBackend, normalizeOpenAIBaseUrl, openAIChatCompletionsUrl, type BackendType } from '../src/backend.js';

describe('detectBackend', () => {
  it('detects ollama for localhost:11434', () => {
    assert.equal(detectBackend('http://localhost:11434'), 'ollama');
  });

  it('detects ollama for 127.0.0.1:11434', () => {
    assert.equal(detectBackend('http://127.0.0.1:11434'), 'ollama');
  });

  it('detects openai for api.openai.com', () => {
    assert.equal(detectBackend('https://api.openai.com'), 'openai');
  });

  it('detects anthropic for api.anthropic.com', () => {
    assert.equal(detectBackend('https://api.anthropic.com'), 'anthropic');
  });

  it('detects openai for URLs with /v1', () => {
    assert.equal(detectBackend('http://my-server:8080/v1'), 'openai');
  });

  it('defaults to openai for unknown URLs', () => {
    assert.equal(detectBackend('http://my-server:8080'), 'openai');
  });
});

describe('OpenAI URL helpers', () => {
  it('normalizes a base URL that already includes /v1', () => {
    assert.equal(normalizeOpenAIBaseUrl('https://example.test/v1'), 'https://example.test');
  });

  it('normalizes a base URL with trailing slash and /v1', () => {
    assert.equal(normalizeOpenAIBaseUrl('https://example.test/v1/'), 'https://example.test');
  });

  it('builds chat completions URL for a root base URL', () => {
    assert.equal(openAIChatCompletionsUrl('https://example.test'), 'https://example.test/v1/chat/completions');
  });

  it('builds chat completions URL without duplicating /v1', () => {
    assert.equal(openAIChatCompletionsUrl('https://example.test/v1'), 'https://example.test/v1/chat/completions');
  });
});
