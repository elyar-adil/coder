import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffPreview, elapsedLabel, isWaitingForFirstToken, toolPresentation, tuiLayout, visibleTimelineEntries, waitingIndicatorFrame } from '../src/ui/tui-design.js';

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

test('waitingIndicatorFrame is deterministic and animates across frames', () => {
  const colors = { accent: '#88c0d0', subtle: '#7b88a1' };
  assert.equal(waitingIndicatorFrame(3, colors), waitingIndicatorFrame(3, colors));
  assert.notEqual(waitingIndicatorFrame(0, colors), waitingIndicatorFrame(1, colors));
  assert.notEqual(waitingIndicatorFrame(1, colors), waitingIndicatorFrame(2, colors));
});

test('waitingIndicatorFrame gradient gives the dots distinct colors per frame', () => {
  const colors = { accent: '#88c0d0', subtle: '#7b88a1' };
  for (const frame of [0, 5, 11, 17, 23]) {
    const dotColors = [...waitingIndicatorFrame(frame, colors).matchAll(/\{(#\w{6})-fg\}\.\{\/#\w{6}-fg\}/g)].map((match) => match[1]);
    assert.equal(dotColors.length, 3, `frame ${frame} must render three tagged dots, got ${JSON.stringify(waitingIndicatorFrame(frame, colors))}`);
    assert.equal(new Set(dotColors).size, 3, `frame ${frame} dots must differ: ${JSON.stringify(dotColors)}`);
  }
});

test('waitingIndicatorFrame wraps cleanly at large frame numbers', () => {
  const colors = { accent: '#88c0d0', subtle: '#7b88a1' };
  assert.equal(waitingIndicatorFrame(24, colors), waitingIndicatorFrame(0, colors));
  assert.equal(waitingIndicatorFrame(49, colors), waitingIndicatorFrame(1, colors));
  assert.equal(waitingIndicatorFrame(72, colors), waitingIndicatorFrame(0, colors));
  assert.match(waitingIndicatorFrame(10_000, colors), /\{\#[0-9a-f]{6}-fg\}\.\{\/#\w{6}-fg\}/);
});

test('waitingIndicatorFrame degrades gracefully for non-hex colors', () => {
  const tagged = waitingIndicatorFrame(7, { accent: 'light-cyan', subtle: 'gray' });
  assert.equal(tagged, '{light-cyan-fg}...{/light-cyan-fg}');
  assert.equal(waitingIndicatorFrame(7, { accent: '#88c0d0', subtle: 'gray' }), '{#88c0d0-fg}...{/#88c0d0-fg}');
  assert.doesNotThrow(() => waitingIndicatorFrame(7, { accent: undefined as unknown as string, subtle: '' }));
  assert.doesNotThrow(() => waitingIndicatorFrame(Number.NaN, { accent: '#88c0d0', subtle: '#7b88a1' }));
  assert.equal(waitingIndicatorFrame(Number.NaN, { accent: '#88c0d0', subtle: '#7b88a1' }).replace(/\{[^}]*\}/g, ''), '...');
});

test('first-token gating follows the live render state', () => {
  assert.equal(isWaitingForFirstToken({ pendingTurns: 1, streamingEntries: 0, runningTimelineEntries: 0, sessionHasTimeline: true }), true);
  assert.equal(isWaitingForFirstToken({ pendingTurns: 1, streamingEntries: 1, runningTimelineEntries: 0, sessionHasTimeline: true }), false);
  assert.equal(isWaitingForFirstToken({ pendingTurns: 0, streamingEntries: 0, runningTimelineEntries: 0, sessionHasTimeline: true }), false);
  assert.equal(isWaitingForFirstToken({ pendingTurns: 1, streamingEntries: 0, runningTimelineEntries: 1, sessionHasTimeline: true }), false);
  assert.equal(isWaitingForFirstToken({ pendingTurns: 1, streamingEntries: 0, runningTimelineEntries: 1, sessionHasTimeline: false }), false);
  assert.equal(isWaitingForFirstToken({ pendingTurns: 1, streamingEntries: 0, runningTimelineEntries: 0, sessionHasTimeline: false }), false);
});
