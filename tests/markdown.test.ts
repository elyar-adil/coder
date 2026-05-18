/**
 * tests/markdown.test.ts
 *
 * Unit tests for inlineMarkdown and renderMarkdown.
 * Force color on so chalk produces ANSI sequences regardless of terminal.
 */

process.env.FORCE_COLOR = '1';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { inlineMarkdown, renderMarkdown } from '../src/markdown.js';

describe('inlineMarkdown', () => {
  test('bold with **', () => {
    const result = inlineMarkdown('hello **world**');
    assert.ok(result.includes('world'));
    assert.ok(!result.includes('**'));
  });

  test('bold with __', () => {
    const result = inlineMarkdown('hello __world__');
    assert.ok(result.includes('world'));
    assert.ok(!result.includes('__'));
  });

  test('italic with *', () => {
    const result = inlineMarkdown('hello *world*');
    assert.ok(result.includes('world'));
    assert.ok(!result.includes('*'));
  });

  test('italic with _', () => {
    const result = inlineMarkdown('hello _world_');
    assert.ok(result.includes('world'));
    assert.ok(!result.includes('_'));
  });

  test('bold+italic with ***', () => {
    const result = inlineMarkdown('hello ***world***');
    assert.ok(result.includes('world'));
  });

  test('inline code with backticks', () => {
    const result = inlineMarkdown('use `const x = 1`');
    assert.ok(result.includes('const x = 1'));
    assert.ok(!result.includes('`'));
  });

  test('strikethrough with ~~', () => {
    const result = inlineMarkdown('~~deleted~~');
    assert.ok(result.includes('deleted'));
    assert.ok(!result.includes('~~'));
  });

  test('handles empty string', () => {
    assert.equal(inlineMarkdown(''), '');
  });

  test('handles string without markdown', () => {
    assert.equal(inlineMarkdown('plain text'), 'plain text');
  });
});

describe('renderMarkdown', () => {
  test('renders h1 heading', () => {
    const result = renderMarkdown('# Hello', 80);
    assert.ok(result.includes('Hello'));
  });

  test('renders h2 heading', () => {
    const result = renderMarkdown('## Hello', 80);
    assert.ok(result.includes('Hello'));
  });

  test('renders h3 heading', () => {
    const result = renderMarkdown('### Hello', 80);
    assert.ok(result.includes('Hello'));
  });

  test('renders bullet list', () => {
    const result = renderMarkdown('- item1\n* item2', 80);
    assert.match(result, /•/);
    assert.ok(result.includes('item1'));
    assert.ok(result.includes('item2'));
  });

  test('renders numbered list', () => {
    const result = renderMarkdown('1. item1\n2. item2', 80);
    assert.ok(result.includes('item1'));
    assert.ok(result.includes('item2'));
  });

  test('renders blockquote', () => {
    const result = renderMarkdown('> quote', 80);
    assert.ok(result.includes('quote'));
  });

  test('renders horizontal rule (---)', () => {
    const result = renderMarkdown('---', 80);
    assert.match(result, /─/);
  });

  test('renders horizontal rule (***)', () => {
    const result = renderMarkdown('***', 80);
    assert.match(result, /─/);
  });

  test('renders fenced code block', () => {
    const result = renderMarkdown('```python\nprint("hi")\n```', 80);
    assert.match(result, /┌/);
    assert.match(result, /└/);
    assert.ok(result.includes('python'));
    assert.ok(result.includes('print'));
  });

  test('renders diff code block', () => {
    const result = renderMarkdown('```diff\n-old\n+new\n@@\n```', 80);
    assert.ok(result.includes('-old'));
    assert.ok(result.includes('+new'));
    assert.ok(result.includes('@@'));
  });

  test('handles multiple paragraphs', () => {
    const result = renderMarkdown('para1\n\npara2', 80);
    const lines = result.split('\n');
    assert.ok(lines.length >= 2);
  });

  test('uses custom column width', () => {
    const result = renderMarkdown('---', 40);
    assert.ok(result.includes('─'.repeat(40)));
  });
});
