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
