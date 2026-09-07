import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderTuiMarkdown, toolDiff } from '../src/ui/markdown.js';

test('patches use deep, near-black diff backgrounds with readable light text', () => {
  const rendered = renderTuiMarkdown('```diff\n--- app.ts\n+++ app.ts\n@@ -1 +1 @@\n-old\n+{red-fg}new\n```', 80);
  assert.ok(rendered.includes('{#2b1215-bg}{#d99f9f-fg}-old'));
  assert.ok(rendered.includes('{#10281a-bg}{#9fd0a6-fg}+{open}red-fg{close}'));
  assert.ok(rendered.includes('{#ba9ce0-fg}new'));
  assert.ok(rendered.includes('{cyan-fg}@@ -1 +1 @@{/cyan-fg}'));
});

test('write and git tool diffs remain multiline instead of being truncated to a status line', () => {
  const patch = '```diff\n--- app.ts\n+++ app.ts\n-old\n+new\n```';
  assert.equal(toolDiff('edit_file', `OK: edited\n\n${patch}`), patch);
  assert.equal(toolDiff('write_file', `OK: wrote\n\n${patch}`), patch);
  assert.match(toolDiff('git_diff', JSON.stringify({ diff: '-old\n+new\n' }))!, /-old\n\+new/);
  assert.equal(toolDiff('read_file', patch), undefined);
  assert.equal(toolDiff('git_diff', 'Error: failed'), undefined);
});

test('renders GFM pipe tables through the prose path with aligned columns', () => {
  const rendered = renderTuiMarkdown('| 名字 | Age |\n| --- | --- |\n| 张三 | 30 |', 80);
  const plain = rendered.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(plain.includes('名字 │ Age'), `header should be a table row, got: ${plain}`);
  assert.ok(plain.includes('─────┼─────'));
  assert.ok(plain.includes('张三 │ 30'));
});
