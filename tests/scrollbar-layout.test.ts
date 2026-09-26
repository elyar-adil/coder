import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computePillScrollbarState } from '../src/ui/scrollbar.js';

test('scrollbar geometry uses the inner viewport height', () => {
  const element = { iheight: 20, getScrollHeight: () => 100, childBase: 0 } as never;
  const state = computePillScrollbarState(element, { xi: 0, xl: 80, yi: 2, yl: 24 });
  assert.ok(state);
  assert.equal(state.viewportHeight, 20);
  assert.equal(state.maxOffset, 80);
  assert.equal(state.thumbStart, 0);
});

test('scrollbar geometry falls back to the rendered rectangle', () => {
  const element = { iheight: 0, getScrollHeight: () => 40, childBase: 10 } as never;
  const state = computePillScrollbarState(element, { xi: 0, xl: 80, yi: 2, yl: 24 });
  assert.ok(state);
  assert.equal(state.viewportHeight, 22);
  assert.equal(state.maxOffset, 18);
});
