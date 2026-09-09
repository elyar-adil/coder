import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INTRO_DURATION, renderWelcome } from '../src/ui/welcome.js';
import { setActiveTheme, THEMES } from '../src/ui/theme.js';

const strip = (row: string) => row.replace(/\{[^}]*\}/g, '');

test('big MAW logo centers in the terminal and fits the conversation', () => {
  for (const [width, height, terminalHeight] of [[75, 20, 24], [115, 36, 40]]) {
    setActiveTheme('aurora');
    const frame = renderWelcome(width!, height!, terminalHeight!, INTRO_DURATION * 2);
    const plain = frame.map(strip);
    const center = Math.floor((terminalHeight! - 1) / 2);
    assert.equal(frame.length, height);
    assert.ok(plain.every((row) => row.length <= width!));
    for (let row = center - 3; row <= center + 2; row++) assert.ok(plain[row]!.trim().length > 0, `logo row ${row} empty`);
    assert.ok(plain[center]!.includes('█'));
    assert.ok(plain[center + 4]!.includes('T O K E N M A W'));
    assert.ok(plain[center + 5]!.includes('multi-agent coding runtime'));
    assert.deepEqual(frame, renderWelcome(width!, height!, terminalHeight!, INTRO_DURATION * 2));
  }
});

test('narrow terminals fall back to the compact wordmark with a breathing rule', () => {
  setActiveTheme('aurora');
  const frame = renderWelcome(30, 20, 24, 40);
  const plain = frame.map(strip);
  assert.ok(plain[11]!.includes('T O K E N M A W'));
  assert.ok(plain[13]!.includes('─'));
  const tiny = renderWelcome(7, 9, 9, 40).map(strip);
  assert.ok(tiny[4]!.includes('MAW'));
  assert.equal(strip(renderWelcome(1, 1, 1)[0]!), 'M');
});

test('every theme opens from nothing and lands exactly on the settled loop', () => {
  const WIDTH = 75;
  const HEIGHT = 20;
  const TERMINAL_HEIGHT = 24;
  const settledAt = INTRO_DURATION;
  for (const name of Object.keys(THEMES)) {
    setActiveTheme(name);
    try {
      const settled = renderWelcome(WIDTH, HEIGHT, TERMINAL_HEIGHT, settledAt);
      // Frame 0: the logo band must be blank (the brand and tagline lines
      // below it are static text, not part of the act). Rain glyphs in the
      // phosphor theme are scenery the mark condenses out of, not the act.
      const blank = (row: string) => strip(row).replace(/[\uFF66-\uFF9D01]/g, '').trim();
      assert.ok(renderWelcome(WIDTH, HEIGHT, TERMINAL_HEIGHT, 0).slice(8, 14).map(blank).every((row) => row === ''), `${name}: frame 0 must be blank`);
      // Monotonic birth: the letterform must never shrink — once glyphs
      // are on screen they never come off. We count block glyphs per logo
      // row (full-width katakana rain is scenery and excluded) and require
      // the counts to never decrease across the act.
      const blocks = (f: number): number[] =>
        renderWelcome(WIDTH, HEIGHT, TERMINAL_HEIGHT, f).slice(8, 14)
          .map((row) => (strip(row).match(/[█║╗╝╔╚═░▒▓]/g) ?? []).length);
      const zero = blocks(0);
      assert.ok(zero.every((count) => count === 0), `${name}: frame 0 must paint no letterform`);
      for (let f = 1; f <= INTRO_DURATION; f++) {
        const previous = blocks(f - 1);
        const now = f < INTRO_DURATION ? blocks(f) : blocks(settledAt);
        for (let r = 0; r < now.length; r++) {
          assert.ok(now[r]! >= previous[r]!, `${name}: letterform shrank at frame ${f}, row ${r} (${previous[r]} → ${now[r]})`);
        }
      }
      // The first loop frame must be exactly the settled state.
      const last = renderWelcome(WIDTH, HEIGHT, TERMINAL_HEIGHT, INTRO_DURATION);
      assert.deepEqual(last, settled, `${name}: intro handoff must equal the settled loop state`);
      // The act moves: mid-intro differs from both endpoints.
      const mid = renderWelcome(WIDTH, HEIGHT, TERMINAL_HEIGHT, Math.floor(INTRO_DURATION / 2)).join('');
      assert.notEqual(mid, renderWelcome(WIDTH, HEIGHT, TERMINAL_HEIGHT, 0).join(''), `${name}: intro must progress`);
      // Deterministic.
      assert.deepEqual(renderWelcome(WIDTH, HEIGHT, TERMINAL_HEIGHT, 7), renderWelcome(WIDTH, HEIGHT, TERMINAL_HEIGHT, 7), `${name}: render must be deterministic`);
    } finally {
      setActiveTheme(undefined);
    }
  }
});

test('the shine ping-pongs cleanly: glyphs stay pristine while colors move', () => {
  setActiveTheme('aurora');
  try {
    const settled = renderWelcome(75, 20, 24, INTRO_DURATION).map(strip);
    for (let f = INTRO_DURATION; f < 400; f++) {
      assert.deepEqual(renderWelcome(75, 20, 24, f).map(strip), settled, `glyphs must never corrupt, frame ${f}`);
    }
    const initial = renderWelcome(75, 20, 24, INTRO_DURATION);
    const later = renderWelcome(75, 20, 24, INTRO_DURATION + 40);
    const changed = initial.map((row, index) => row === later[index] ? -1 : index).filter((index) => index >= 0);
    assert.deepEqual(changed, [8, 9, 10, 11, 12, 13], 'only the logo rows may animate');
    const stripColors = (frame: string[]): string[] => frame.slice(8, 14);
    assert.notDeepEqual(stripColors(initial), stripColors(later), 'the shine must keep moving');
    assert.deepEqual(initial, renderWelcome(75, 20, 24, INTRO_DURATION), 'render must stay deterministic');
  } finally {
    setActiveTheme(undefined);
  }
});

test('the phosphor theme rains glyphs through the background, not the letterforms', () => {
  setActiveTheme('matrix');
  try {
    const frame = renderWelcome(75, 20, 24, INTRO_DURATION + 90);
    const plain = frame.map(strip);
    assert.equal(frame.length, 20);
    assert.ok(plain.every((row) => row.length <= 75));
    const logoText = plain.slice(8, 14).join('');
    assert.ok(logoText.includes('█'), 'letterforms must persist under the rain');
    const background = plain.slice(0, 7).join('') + plain.slice(17).join('');
    assert.ok(['0', '1', 'ﾊ', 'ﾋ', 'ｸ', 'ｼ', 'ｱ'].some((glyph) => background.includes(glyph)), 'rain glyphs must fill the background around the mark');
    assert.ok(plain[15]!.includes('T O K E N M A W'), 'brand line must survive the rain');
    assert.ok(plain[16]!.includes('multi-agent coding runtime'), 'tagline must survive the rain');
    const next = renderWelcome(75, 20, 24, INTRO_DURATION + 130).map(strip);
    assert.notDeepEqual(next.slice(0, 8), plain.slice(0, 8), 'the background rain must fall between frames');
    assert.deepEqual(frame, renderWelcome(75, 20, 24, INTRO_DURATION + 90), 'render must stay deterministic');
  } finally {
    setActiveTheme(undefined);
  }
});
