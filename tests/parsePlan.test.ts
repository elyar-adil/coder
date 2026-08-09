/**
 * tests/parsePlan.test.ts
 *
 * Unit tests for parsePlan — the JSON plan parser.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../src/runtime/coordinator.js';

describe('parsePlan', () => {
  test('parses valid JSON array', () => {
    const input = '[{"title":"Step 1","detail":"Do X"},{"title":"Step 2","detail":"Do Y"}]';
    const result = parsePlan(input);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.title, 'Step 1');
    assert.equal(result[0]!.detail, 'Do X');
    assert.equal(result[1]!.title, 'Step 2');
    assert.equal(result[1]!.detail, 'Do Y');
  });

  test('handles empty array', () => {
    const result = parsePlan('[]');
    assert.equal(result.length, 0);
  });

  test('handles missing fields with defaults', () => {
    const input = '[{"title":"Only title"},{"detail":"Only detail"},{"empty":true}]';
    const result = parsePlan(input);
    assert.equal(result[0]!.title, 'Only title');
    assert.equal(result[0]!.detail, '');
    assert.equal(result[1]!.title, 'step');
    assert.equal(result[1]!.detail, 'Only detail');
    assert.equal(result[2]!.title, 'step');
    assert.equal(result[2]!.detail, '');
  });

  test('strips markdown code fences', () => {
    const input = '```json\n[{"title":"A","detail":"B"}]\n```';
    const result = parsePlan(input);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.title, 'A');
  });

  test('strips leading/trailing whitespace', () => {
    const input = '   [ {"title":"X","detail":"Y"} ]   ';
    const result = parsePlan(input);
    assert.equal(result.length, 1);
  });

  test('throws on invalid JSON', () => {
    assert.throws(() => parsePlan('not json'), /Unexpected token|SyntaxError/);
  });

  test('throws on non-array JSON', () => {
    assert.throws(() => parsePlan('{"title":"A","detail":"B"}'), /expects JSON array/);
  });
});