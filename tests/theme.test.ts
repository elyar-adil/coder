import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MARKDOWN_THEME, getMarkdownTheme, setMarkdownTheme } from '../src/markdown.js';
import { DEFAULT_THEME, resolveTheme, setActiveTheme, themeNames, THEMES } from '../src/ui/theme.js';

test('unknown theme names fall back to the default theme', () => {
  assert.equal(resolveTheme('nope').name, DEFAULT_THEME);
  assert.equal(resolveTheme(undefined).name, DEFAULT_THEME);
  assert.equal(resolveTheme('NORD').name, 'nord');
  assert.equal(resolveTheme('MATRIX').name, 'matrix');
});

test('every theme ships a complete palette', () => {
  for (const theme of Object.values(THEMES)) {
    for (const key of ['background', 'composer', 'activity', 'elevated', 'modal', 'text', 'muted', 'subtle', 'accent', 'success', 'warning', 'error'] as const) {
      assert.ok(theme.ui[key], `${theme.name} is missing ui.${key}`);
    }
    for (const key of ['text', 'muted', 'accent', 'heading', 'codeBg', 'codeText', 'codeFence', 'diffAddBg', 'diffAddText', 'diffDelBg', 'diffDelText'] as const) {
      assert.ok(theme.markdown[key], `${theme.name} is missing markdown.${key}`);
    }
    assert.equal(theme.syntax.length, 5, `${theme.name} needs five syntax token colors`);
  }
});

test('setActiveTheme drives the markdown renderer colors and can be reset', () => {
  try {
    setActiveTheme('nord');
    assert.equal(getMarkdownTheme().accent, THEMES.nord!.markdown.accent);
    setMarkdownTheme(DEFAULT_MARKDOWN_THEME);
    setActiveTheme('midnight');
    assert.deepEqual(getMarkdownTheme(), THEMES.midnight!.markdown);
  } finally {
    setActiveTheme(DEFAULT_THEME);
  }
});
