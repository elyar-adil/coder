import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chatStream, detectBackend, normalizeOpenAIBaseUrl, openAIChatCompletionsUrl, type BackendType } from '../src/backend.js';

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

describe('Anthropic prompt caching', () => {
  const config = { type: 'anthropic' as const, baseUrl: 'http://test', model: 'test', apiKey: 'test' };
  const tool = {
    type: 'function' as const,
    function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {}, required: [] } },
  };
  const captureBody = async (t: { mock: { method: (object: object, key: string, value: unknown) => unknown } }): Promise<Record<string, unknown>> => {
    let body: Record<string, unknown> | undefined;
    t.mock.method(globalThis, 'fetch', async (_url: string, init: { body?: unknown }) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response('event: message_stop\ndata: {}\n\n', { status: 200 });
    });
    for await (const _chunk of chatStream(config, 'System prompt', [{ role: 'user', content: 'hello' }], [tool])) { /* drain */ }
    assert.ok(body, 'the request body must be captured');
    return body;
  };

  it('marks tools, system, and the newest message with cache breakpoints', async (t) => {
    const body = await captureBody(t);
    const system = body.system as Array<Record<string, unknown>>;
    assert.deepEqual(system[0]!.cache_control, { type: 'ephemeral' });
    const tools = body.tools as Array<Record<string, unknown>>;
    assert.deepEqual(tools.at(-1)!.cache_control, { type: 'ephemeral' });
    const messages = body.messages as Array<Record<string, unknown>>;
    const content = messages.at(-1)!.content as Array<Record<string, unknown>>;
    assert.deepEqual(content.at(-1)!.cache_control, { type: 'ephemeral' });
  });

  it('ANTHROPIC_PROMPT_CACHE=0 disables the breakpoints', async (t) => {
    const previous = process.env.ANTHROPIC_PROMPT_CACHE;
    process.env.ANTHROPIC_PROMPT_CACHE = '0';
    try {
      const body = await captureBody(t);
      assert.equal(typeof body.system, 'string');
      const tools = body.tools as Array<Record<string, unknown>>;
      assert.equal('cache_control' in tools.at(-1)!, false);
      const messages = body.messages as Array<Record<string, unknown>>;
      assert.equal(typeof messages.at(-1)!.content, 'string');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_PROMPT_CACHE;
      else process.env.ANTHROPIC_PROMPT_CACHE = previous;
    }
  });
});
