import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installBlessedEmojiWidthSupport } from '../src/ui/blessed-unicode.js';

test('Blessed emoji width shim makes modern emoji occupy two columns', () => {
  const unicode = {
    charWidth: (_value: string | number, _index?: number) => 1,
    codePointAt: (value: string, index = 0) => value.codePointAt(index) ?? 0,
  };

  installBlessedEmojiWidthSupport(unicode);

  assert.equal(unicode.charWidth('😀'), 2);
  assert.equal(unicode.charWidth('A'), 1);
  assert.equal(unicode.charWidth(0x1F680), 2);
});

test('Blessed emoji width shim is safe to install for each TUI session', () => {
  let originalCalls = 0;
  const unicode = {
    charWidth: (_value: string | number, _index?: number) => { originalCalls += 1; return 1; },
    codePointAt: (value: string, index = 0) => value.codePointAt(index) ?? 0,
  };

  installBlessedEmojiWidthSupport(unicode);
  installBlessedEmojiWidthSupport(unicode);

  assert.equal(unicode.charWidth('text'), 1);
  assert.equal(originalCalls, 1, 'the original width function must be wrapped only once');
});
