import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderWelcome } from '../src/ui/welcome.js';
import { setActiveTheme } from '../src/ui/theme.js';

const strip = (row: string) => row.replace(/\{[^}]*\}/g, '');

test('big MAW logo centers in the terminal and fits the conversation', () => {
  for (const [width, height, terminalHeight] of [[75, 20, 24], [115, 36, 40]]) {
    const frame = renderWelcome(width!, height!, terminalHeight!);
    const plain = frame.map(strip);
    const center = Math.floor((terminalHeight! - 1) / 2);
    assert.equal(frame.length, height);
    assert.ok(plain.every((row) => row.length <= width!));
    for (let row = center - 3; row <= center + 2; row++) assert.ok(plain[row]!.trim().length > 0, `logo row ${row} empty`);
    assert.ok(plain[center]!.includes('█'));
    assert.ok(plain[center + 4]!.includes('T O K E N M A W'));
    assert.ok(plain[center + 5]!.includes('multi-agent coding runtime'));
    assert.deepEqual(frame, renderWelcome(width!, height!, terminalHeight!));
  }
});

test('narrow terminals fall back to the compact wordmark with a breathing rule', () => {
  const frame = renderWelcome(30, 20, 24, 0);
  const plain = frame.map(strip);
  assert.ok(plain[11]!.includes('T O K E N M A W'));
  assert.ok(plain[13]!.includes('─'));
  const tiny = renderWelcome(7, 9, 9, 0).map(strip);
  assert.ok(tiny[4]!.includes('MAW'));
  assert.equal(strip(renderWelcome(1, 1, 1)[0]!), 'M');
});

test('the shine ping-pongs cleanly: glyphs stay pristine while colors move', () => {
  setActiveTheme('aurora');
  try {
    const settled = renderWelcome(75, 20, 24, 0).map(strip);
    for (let f = 1; f < 400; f++) {
      assert.deepEqual(renderWelcome(75, 20, 24, f).map(strip), settled, `glyphs must never corrupt, frame ${f}`);
    }
    const initial = renderWelcome(75, 20, 24, 0);
    const later = renderWelcome(75, 20, 24, 40);
    const changed = initial.map((row, index) => row === later[index] ? -1 : index).filter((index) => index >= 0);
    assert.deepEqual(changed, [8, 9, 10, 11, 12, 13], 'only the logo rows may animate');
    const stripColors = (frame: string[]): string[] => frame.slice(8, 14);
    assert.notDeepEqual(stripColors(initial), stripColors(later), 'the shine must keep moving');
    assert.deepEqual(initial, renderWelcome(75, 20, 24, 0), 'render must stay deterministic');
  } finally {
    setActiveTheme(undefined);
  }
});

test('the phosphor theme rains glyphs through the background, not the letterforms', () => {
  setActiveTheme('matrix');
  try {
    const frame = renderWelcome(75, 20, 24, 90);
    const plain = frame.map(strip);
    assert.equal(frame.length, 20);
    assert.ok(plain.every((row) => row.length <= 75));
    const logoText = plain.slice(8, 14).join('');
    assert.ok(logoText.includes('█'), 'letterforms must persist under the rain');
    const background = plain.slice(0, 7).join('') + plain.slice(17).join('');
    assert.ok(['0', '1', 'ﾊ', 'ﾋ', 'ｸ', 'ｼ', 'ｱ'].some((glyph) => background.includes(glyph)), 'rain glyphs must fill the background around the mark');
    assert.ok(plain[15]!.includes('T O K E N M A W'), 'brand line must survive the rain');
    assert.ok(plain[16]!.includes('multi-agent coding runtime'), 'tagline must survive the rain');
    const next = renderWelcome(75, 20, 24, 130).map(strip);
    assert.notDeepEqual(next.slice(0, 8), plain.slice(0, 8), 'the background rain must fall between frames');
    assert.deepEqual(frame, renderWelcome(75, 20, 24, 90), 'render must stay deterministic');
  } finally {
    setActiveTheme(undefined);
  }
});
