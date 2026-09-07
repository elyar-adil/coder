import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffPreview, elapsedLabel, toolPresentation, tuiLayout, visibleTimelineEntries } from '../src/ui/tui-design.js';

test('responsive layout protects transcript width', () => {
  assert.equal(tuiLayout(120, true).activity, 'split');
  assert.equal(tuiLayout(120, true).conversationWidth, 84);
  assert.equal(tuiLayout(80, true).activity, 'overlay');
  assert.equal(tuiLayout(80, false).activity, 'hidden');
  assert.equal(tuiLayout(50, false).horizontalPadding, 1);
});

test('tool presentation turns raw calls into readable activity', () => {
  assert.deepEqual(toolPresentation('edit_file', JSON.stringify({ path: 'src/app.ts' })), { label: 'Edit', detail: 'src/app.ts' });
  assert.deepEqual(toolPresentation('read_files', JSON.stringify({ paths: ['a.ts', 'b.ts', 'c.ts'] })), { label: 'Read files', detail: 'a.ts, b.ts' });
  assert.equal(toolPresentation('unknown_tool').label, 'Unknown tool');
});

test('elapsed and diff labels stay compact', () => {
  assert.equal(elapsedLabel(0, 1000), '');
  assert.equal(elapsedLabel(1_000, 66_000), '1m 5s');
  assert.match(diffPreview(['```diff', ...Array.from({ length: 30 }, (_, i) => `+line ${i}`), '```'].join('\n')), /more lines/);
});

test('long timelines render through a bounded recent window', () => {
  const timeline = Array.from({ length: 10_000 }, (_, index) => ({
    id: String(index), kind: 'message' as const, role: 'assistant' as const,
    content: `message ${index}`, status: 'completed' as const,
  }));
  const result = visibleTimelineEntries(timeline);
  assert.equal(result.entries.length, 400);
  assert.equal(result.omitted, 9_600);
  assert.equal(result.entries[0]?.content, 'message 9600');
});
