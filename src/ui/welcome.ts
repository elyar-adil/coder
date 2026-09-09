/** A big animated wordmark: theme-gradient block letters with a clean ping-ponging shine; the phosphor theme rains glyphs through the background instead. */
import { activeTuiTheme } from './theme.js';

const GLYPH_LETTERS: string[][] = [
  ['███╗   ███╗', '████╗ ████║', '██╔████╔██║', '██║╚██╔╝██║', '██║ ╚═╝ ██║', '╚═╝     ╚═╝'],
  [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  ['██╗    ██╗', '██║    ██║', '██║ █╗ ██║', '██║███╗██║', '╚███╔███╔╝', ' ╚══╝╚══╝'],
];

const LOGO: string[] = (() => {
  const letters = GLYPH_LETTERS.map((rows) => {
    const widest = Math.max(...rows.map((row) => row.length));
    return rows.map((row) => row.padEnd(widest));
  });
  const rows: string[] = [];
  for (let line = 0; line < 6; line++) rows.push(letters.map((letter) => letter[line]).join(' '));
  return rows;
})();

const LOGO_WIDTH = LOGO[0]!.length;
const BRAND = 'T O K E N M A W';
const TAGLINE = 'multi-agent coding runtime';
const RAIN_GLYPHS = '01ﾊﾋｸｼｱｳﾄﾅﾆﾇﾈﾓﾘ';

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function mix(from: string, to: string, t: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  return '#' + a.map((channel, index) => Math.round(channel + (b[index]! - channel) * t).toString(16).padStart(2, '0')).join('');
}

/** Stateless pseudo-randomness keyed by frame and cell, so the render stays a pure function. */
function flicker(frame: number, seed: number): number {
  let x = (Math.imul(frame + 1, 2654435761) ^ Math.imul(seed + 1, 97531)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x45d9f3b);
  x ^= x >>> 16;
  x = Math.imul(x, 0x45d9f3b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export function renderWelcome(width: number, height: number, terminalHeight = height, frame = 0): string[] {
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  const rows = Array.from({ length: height }, () => '');
  const center = Math.max(0, Math.min(height - 1, Math.floor((terminalHeight - 1) / 2)));
  const palette = activeTuiTheme().markdown;
  const cycle = frame % 80;
  const logoTop = center - 3;
  if (width >= LOGO_WIDTH + 3 && logoTop >= 0 && logoTop + LOGO.length <= height) {
    // One clean motion layer for every theme: the shine rides diagonal "/"
    // stripes (distance along u = x + rise · y) and ping-pongs end to end.
    // Its phase advances at a rate that itself sways, so the band lingers at
    // the ends, then dashes across — never a flat metronome. No other motion
    // touches the letterforms.
    const rise = 2;
    const span = LOGO_WIDTH + rise * (LOGO.length - 1);
    const theta = 0.04 * frame + 3.5 * Math.sin(frame / 170);
    const ride = Math.sin(theta);
    const bandCenter = span / 2 + ride * (span / 2 + 6);
    const bandWidth = 18;
    const glowBoost = 0.7;
    // The phosphor theme swaps the empty space around the mark for glyph
    // rain: per-column heads fall the full height of the screen, trailing a
    // fading wake. The letterforms themselves stay pristine on top.
    const effect = activeTuiTheme().name === 'matrix' ? 'rain' : 'shine';
    const RAIN_TRAIL = 7;
    const rainCycle = height + RAIN_TRAIL;
    const rainHead: number[] = [];
    const rainPass: number[] = [];
    for (let column = 0; column < width; column++) {
      const speed = 0.12 + flicker(column * 13 + 5, 401) * 0.23;
      const phase = flicker(column * 13 + 7, 402) * 240;
      const travel = frame * speed + phase;
      rainHead.push(Math.floor(travel % rainCycle));
      rainPass.push(Math.floor(travel / rainCycle));
    }
    const rainAt = (row: number, x: number): string => {
      if (effect !== 'rain') return ' ';
      const depth = rainHead[x]! - row;
      if (depth < 0 || depth > RAIN_TRAIL) return ' ';
      // Wet/dry gates and glyphs are keyed to the column's current pass, not
      // the frame: characters hold steady while the trail covers them and only
      // re-roll when the head wraps around — the rain shimmers, not flickers.
      if (flicker(rainPass[x]! * 89 + 7, row * 31 + x) <= 0.25) return ' ';
      const slot = flicker(rainPass[x]! * 97 + 13, row * 53 + x) * RAIN_GLYPHS.length;
      const tick = Math.floor(frame / 8);
      const mutated = flicker(tick * 71 + 3, row * 53 + x) > 0.94;
      const glyph = RAIN_GLYPHS[Math.floor(mutated ? slot + 5.5 : slot) % RAIN_GLYPHS.length]!;
      const color = depth === 0 ? palette.text : mix(mix(palette.accent, '#000000', 0.55), palette.text, 1 - depth / RAIN_TRAIL);
      return `{${color}-fg}${glyph}{/${color}-fg}`;
    };
    const rainPad = (row: number, from: number, to: number): string => {
      let pad = '';
      for (let x = from; x < to; x++) pad += rainAt(row, x);
      return pad;
    };
    const leftCells = Math.floor((width - LOGO_WIDTH) / 2);
    LOGO.forEach((template, rowIndex) => {
      const row = logoTop + rowIndex;
      let line = '';
      for (let column = 0; column < LOGO_WIDTH; column++) {
        const diagonal = column + rowIndex * rise;
        const dx = diagonal - bandCenter;
        const glow = Math.exp(-(dx * dx) / bandWidth);
        const base = mix(palette.accent, palette.heading, diagonal / span);
        const intensity = Math.min(0.95, glow * glowBoost);
        const color = intensity > 0.03 ? mix(base, palette.headingStrong, intensity) : base;
        const glyph = template[column]!;
        if (glyph === ' ') {
          line += rainAt(row, leftCells + column);
          continue;
        }
        line += `{${color}-fg}${glyph}{/${color}-fg}`;
      }
      rows[row] = `${rainPad(row, 0, leftCells)}${line}${rainPad(row, leftCells + LOGO_WIDTH, width)}`;
    });
    const brandRow = logoTop + LOGO.length + 1;
    if (brandRow < height && BRAND.length <= width) {
      const brandLeft = Math.floor((width - BRAND.length) / 2);
      const brand = `{${palette.headingStrong}-fg}{bold}${BRAND}{/bold}{/${palette.headingStrong}-fg}`;
      rows[brandRow] = `${rainPad(brandRow, 0, brandLeft)}${brand}${rainPad(brandRow, brandLeft + BRAND.length, width)}`;
    }
    const taglineRow = brandRow + 1;
    if (taglineRow < height && TAGLINE.length <= width) {
      const taglineLeft = Math.floor((width - TAGLINE.length) / 2);
      const tagline = `{${palette.muted}-fg}${TAGLINE}{/${palette.muted}-fg}`;
      rows[taglineRow] = `${rainPad(taglineRow, 0, taglineLeft)}${tagline}${rainPad(taglineRow, taglineLeft + TAGLINE.length, width)}`;
    }
    for (let row = 0; row < height; row++) {
      if (rows[row] !== '') continue;
      let line = '';
      for (let column = 0; column < width; column++) line += rainAt(row, column);
      rows[row] = line;
    }
    return rows;
  }
  const wordmark = width >= 17 ? BRAND : 'MAW'.slice(0, Math.min(3, width));
  rows[center] = `${' '.repeat(Math.max(0, Math.floor((width - wordmark.length) / 2)))}{white-fg}{bold}${wordmark}{/bold}{/white-fg}`;
  if (center + 2 < height && width >= 5) {
    // A four-second, eased breath derived from the theme accent, with a
    // slight spatial falloff and no discrete moving cell.
    const breath = (1 - Math.cos(cycle / 80 * Math.PI * 2)) / 2;
    const rule = [0, 1, 2].map((index) => {
      const intensity = breath * (index === 1 ? 1 : 0.85);
      const color = mix(mix(palette.accent, '#000000', 0.65), palette.accent, intensity);
      return `{${color}-fg}─{/${color}-fg}`;
    }).join('');
    rows[center + 2] = `${' '.repeat(Math.floor((width - 3) / 2))}${rule}`;
  }
  return rows;
}
