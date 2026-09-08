import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatStream, type BackendConfig } from '../src/backend.js';

const cases: Array<{ type: BackendConfig['type']; body: string }> = [
  { type: 'ollama', body: [
    JSON.stringify({ message: { thinking: 'Inspect. ' }, done: false }),
    JSON.stringify({ message: { thinking: 'Verify.', content: 'Done.' }, done: true }),
  ].join('\n') },
  { type: 'openai', body: [
    'data: {"choices":[{"delta":{"reasoning_content":"Inspect. "}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"Verify.","content":"Done."}}]}',
    'data: [DONE]', '',
  ].join('\n\n') },
  { type: 'anthropic', body: [
    'event: content_block_delta\ndata: {"delta":{"type":"thinking_delta","thinking":"Inspect. "}}',
    'event: content_block_delta\ndata: {"delta":{"type":"thinking_delta","thinking":"Verify."}}',
    'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Done."}}',
    'event: message_stop\ndata: {}', '',
  ].join('\n\n') },
];

for (const entry of cases) test(`${entry.type} preserves streamed thinking separately from answer text`, async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(entry.body, { status: 200 }));
  const chunks = [];
  for await (const chunk of chatStream({ type: entry.type, baseUrl: 'http://test', model: 'test', apiKey: 'test' }, '', [])) chunks.push(chunk);
  assert.equal(chunks.map((chunk) => chunk.thinking ?? '').join(''), 'Inspect. Verify.');
  assert.equal(chunks.map((chunk) => chunk.content ?? '').join(''), 'Done.');
});

test('ollama reports prompt and generation usage from the terminal frame', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(`${JSON.stringify({ message: { content: 'ok' }, done: true, prompt_eval_count: 12, eval_count: 4 })}\n`, { status: 200 }));
  const chunks = [];
  for await (const chunk of chatStream({ type: 'ollama', baseUrl: 'http://test', model: 'test' }, '', [])) chunks.push(chunk);
  assert.deepEqual(chunks.at(-1)?.usage, { inputTokens: 12, outputTokens: 4 });
});

test('openai chat reports usage and cached input tokens', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response([
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":15}}}',
    'data: [DONE]', '',
  ].join('\n\n'), { status: 200 }));
  const chunks = [];
  for await (const chunk of chatStream({ type: 'openai', baseUrl: 'http://test', model: 'test' }, '', [])) chunks.push(chunk);
  assert.deepEqual(chunks.find((chunk) => chunk.usage)?.usage, { inputTokens: 20, outputTokens: 3, cachedInputTokens: 15, reasoningTokens: undefined });
});
