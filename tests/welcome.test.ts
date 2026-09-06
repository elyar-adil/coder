import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderWelcome } from '../src/ui/welcome.js';

test('static wordmark centers in the entire terminal without overflowing the conversation', () => {
  for (const [width, height, terminalHeight] of [[75, 20, 24], [115, 36, 40], [1, 1, 1]]) {
    const frame = renderWelcome(width!, height!, terminalHeight!);
    const plain = frame.map((row) => row.replace(/\{[^}]*\}/g, ''));
    assert.equal(frame.length, height);
    assert.ok(plain.every((row) => row.length <= width!));
    assert.ok(plain[Math.floor((terminalHeight! - 1) / 2)]!.includes(width! >= 9 ? 'C O D E R' : 'C'));
    assert.deepEqual(frame, renderWelcome(width!, height!, terminalHeight!));
  }
});

test('only the short underline animates; wordmark and geometry stay stable', () => {
  const initial = renderWelcome(75, 20, 24, 0);
  const next = renderWelcome(75, 20, 24, 40);
  const changed = initial.map((row, index) => row === next[index] ? -1 : index).filter((index) => index >= 0);
  assert.deepEqual(changed, [13]);
  assert.equal(initial[13]!.replace(/\{[^}]*\}/g, ''), next[13]!.replace(/\{[^}]*\}/g, ''));
});
