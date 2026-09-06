import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatStream } from '../src/backend.js';

test('Responses streams text, thinking and tool calls, and replays tool results', async (t) => {
  let request: Record<string, any> = {};
  const events = [
    { type: 'response.reasoning_summary_text.delta', delta: 'Checking files.' },
    { type: 'response.output_text.delta', delta: 'Writing.' },
    { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] } },
    { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'write_file', arguments: '{"path":"resume.html","content":"<html></html>"}' } },
    { type: 'response.completed' },
  ];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'http://test/v1/responses');
    request = JSON.parse(String(options.body));
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  });
  const chunks = [];
  for await (const chunk of chatStream({ type: 'openai', wireApi: 'responses', baseUrl: 'http://test/v1', model: 'test' }, 'Act.', [
    { role: 'assistant', content: null, responseItems: [{ type: 'reasoning', encrypted_content: 'old' }], tool_calls: [{ id: 'old_call', function: { name: 'read_file', arguments: { path: 'app.ts' } } }] },
    { role: 'tool', content: 'source code', tool_use_id: 'old_call' },
  ])) chunks.push(chunk);
  assert.equal(chunks.map((chunk) => chunk.content ?? '').join(''), 'Writing.');
  assert.equal(chunks.map((chunk) => chunk.thinking ?? '').join(''), 'Checking files.');
  assert.equal(chunks.flatMap((chunk) => chunk.toolCalls ?? [])[0]!.function.arguments.path, 'resume.html');
  assert.equal(chunks.flatMap((chunk) => chunk.responseItems ?? [])[0]!.encrypted_content, 'opaque');
  assert.equal(request.input[0].encrypted_content, 'old');
  assert.equal(request.input[2].type, 'function_call_output');
  assert.equal(request.input[2].call_id, 'old_call');
  assert.equal(request.store, false);
});

test('Responses reports incomplete streams instead of treating them as success', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
  await assert.rejects(async () => {
    for await (const _chunk of chatStream({ type: 'openai', wireApi: 'responses', baseUrl: 'http://test', model: 'test' }, '', [])) { /* consume */ }
  }, /before completion/);
});
