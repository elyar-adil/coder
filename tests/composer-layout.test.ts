import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutComposer } from '../src/ui/composer-layout.js';

const measure = (text: string) => /[^\x00-\x7f]/.test(text) ? 2 : 1;

test('composer wraps Chinese text by terminal cells and keeps cursor inside viewport', () => {
  const result = layoutComposer('ab中文c', 4, 5, measure);
  assert.deepEqual(result.rows, ['ab中', '文c']);
  assert.deepEqual(result.cursor, { row: 1, column: 2 });
});

test('composer preserves pasted newlines and wraps the end cursor', () => {
  const result = layoutComposer('abc\ndefg', 8, 4, measure);
  assert.deepEqual(result.rows, ['abc', 'defg', '']);
  assert.deepEqual(result.cursor, { row: 2, column: 0 });
});
