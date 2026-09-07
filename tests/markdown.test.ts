/**
 * tests/markdown.test.ts
 *
 * Unit tests for inlineMarkdown and renderMarkdown.
 * Force color on so chalk produces ANSI sequences regardless of terminal.
 */

process.env.FORCE_COLOR = '1';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diffKind, inlineMarkdown, renderMarkdown } from '../src/markdown.js';

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

  test('renders patch code block as highlighted diff', () => {
    const result = renderMarkdown('```patch\n--- a.ts\n+++ a.ts\n-old\n+new\n@@ -1 +1 @@\n```', 80);
    assert.ok(result.includes('-old'));
    assert.ok(result.includes('+new'));
    assert.ok(result.includes('@@ -1 +1 @@'));
  });

  test('classifies diff line categories for highlighting', () => {
    assert.equal(diffKind('+new'), 'add');
    assert.equal(diffKind('-old'), 'del');
    assert.equal(diffKind('@@ -1 +1 @@'), 'hunk');
    assert.equal(diffKind('--- a/file.ts'), 'file');
    assert.equal(diffKind(' context'), 'context');
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

describe('gfm tables', () => {
  // Renderer output mixes raw ANSI (italic/strike) with Blessed style tags;
  // strip both so assertions measure the aligned plain text.
  const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\{[^{}]*\}/g, '');

  test('renders a basic pipe table with header separator and aligned columns', () => {
    const rendered = renderMarkdown('| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |', 80);
    const lines = strip(rendered).split('\n');
    assert.equal(lines.length, 4);
    assert.ok(lines[0]!.includes('Name') && lines[0]!.includes('Age'));
    assert.ok(lines[0]!.includes('│'));
    assert.ok(lines[1]!.includes('┼'));
    assert.ok(lines[2]!.includes('Alice') && lines[3]!.includes('Bob'));
  });

  test('aligns columns when cells contain CJK wide characters', () => {
    const rendered = renderMarkdown('| 名字 | Age |\n| --- | --- |\n| 张三 | 30 |', 80);
    const lines = strip(rendered).split('\n');
    const bodyLine = lines[2]!;
    // CJK characters occupy two columns: 名字/张三 cells must line up with the
    // header and the pipe separators, and nothing may be truncated.
    const headerPipe = lines[0]!.indexOf('│');
    const bodyPipe = bodyLine.indexOf('│');
    assert.ok(bodyLine.includes('张三'));
    assert.ok(!bodyLine.includes('…'));
    assert.equal(bodyPipe, headerPipe);
    // CJK chars count as 2 display columns but 1 char, so the separator's ┼
    // sits two chars after the pipe position — proof of width-aware layout.
    assert.equal(lines[1]!.indexOf('┼'), bodyPipe + 2);
  });

  test('honors alignment markers for center and right', () => {
    const rendered = renderMarkdown('| A | B |\n| :-: | --: |\n| x | 12345 |', 80);
    const lines = strip(rendered).split('\n');
    const body = lines[2]!;
    assert.ok(body.includes(' x ') || body.startsWith(' '), `center alignment should pad, got: ${JSON.stringify(body)}`);
    assert.ok(body.trimEnd().endsWith('12345'));
  });

  test('truncates wide tables to the available columns', () => {
    const cell = 'x'.repeat(60);
    const rendered = renderMarkdown(`| Col |\n| --- |\n| ${cell} |`, 40);
    const lines = strip(rendered).split('\n');
    const bodyLine = lines[2]!;
    assert.ok(bodyLine.length <= 42, `expected truncation, got ${bodyLine.length}`);
    assert.ok(bodyLine.includes('…'));
  });

  test('does not treat a pipe line without a delimiter row as a table', () => {
    const rendered = renderMarkdown('just | pipes | here\n\nmore text', 80);
    const lines = strip(rendered).split('\n');
    assert.ok(lines[0]!.includes('just | pipes | here'));
    assert.ok(!lines[0]!.includes('│'));
  });

  test('supports escaped pipes inside cells', () => {
    const rendered = renderMarkdown('| A | B |\n| --- | --- |\n| a\\|b | c |', 80);
    const lines = strip(rendered).split('\n');
    assert.ok(lines[2]!.includes('a|b'));
    assert.ok(lines[2]!.includes(' c ') || lines[2]!.endsWith('c'));
    assert.ok(!lines[0]!.includes('\\|'));
  });

  test('stops consuming rows at a blank line', () => {
    const rendered = renderMarkdown('| A |\n| --- |\n| 1 |\n\n| B | not table\n| x | y |', 80);
    const lines = strip(rendered).split('\n');
    assert.equal(lines.length, 6);
    assert.ok(lines[2]!.includes('1'));
    assert.ok(lines[4]!.includes('| B | not table'));
  });
});
