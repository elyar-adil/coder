import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderTuiMarkdown, toolDiff } from '../src/ui/markdown.js';

test('patches use native terminal colors and escape code resembling UI tags', () => {
  const rendered = renderTuiMarkdown('```diff\n--- app.ts\n+++ app.ts\n@@ -1 +1 @@\n-old\n+{red-fg}new\n```', 80);
  assert.ok(rendered.includes('{#f1dcdc-bg}{#25352c-fg}-old'));
  assert.ok(rendered.includes('{#d9eadc-bg}{#25352c-fg}+{open}red-fg{close}'));
  assert.ok(rendered.includes('{#6141a0-fg}new'));
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
