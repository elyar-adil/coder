/**
 * tests/ndjson.test.ts
 *
 * Unit tests for parseOllamaNdjson — the streaming parser.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseOllamaNdjson } from '../src/master.js';

describe('parseOllamaNdjson', () => {
  test('parses content message', () => {
    const line = '{"message":{"role":"assistant","content":"hello"}}';
    const result = parseOllamaNdjson(line);
    assert.ok(result);
    assert.equal(result!.message?.content, 'hello');
    assert.equal(result!.message?.role, 'assistant');
  });

  test('parses tool_calls message', () => {
    const line = '{"message":{"role":"assistant","tool_calls":[{"function":{"name":"bash","arguments":{"command":"ls"}}}]}}';
    const result = parseOllamaNdjson(line);
    assert.ok(result);
    assert.equal(result!.message?.tool_calls?.length, 1);
    assert.equal(result!.message?.tool_calls?.[0]!.function.name, 'bash');
    assert.equal(result!.message?.tool_calls?.[0]!.function.arguments.command, 'ls');
  });

  test('parses done flag', () => {
    const line = '{"done":true}';
    const result = parseOllamaNdjson(line);
    assert.ok(result);
    assert.equal(result!.done, true);
  });

  test('returns null for empty line', () => {
    assert.equal(parseOllamaNdjson(''), null);
  });

  test('returns null for whitespace-only line', () => {
    assert.equal(parseOllamaNdjson('   \n'), null);
  });

  test('returns null for invalid JSON', () => {
    assert.equal(parseOllamaNdjson('not json {'), null);
  });

  test('handles newline in content', () => {
    const line = '{"message":{"role":"assistant","content":"line1\\nline2"}}';
    const result = parseOllamaNdjson(line);
    assert.ok(result);
    assert.equal(result!.message?.content, 'line1\nline2');
  });
});