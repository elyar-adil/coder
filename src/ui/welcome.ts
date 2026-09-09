/** The big animated wordmark. Every theme plays its own one-shot opening
 * act — under a second, each with a distinct mechanic — before the loop
 * takes over: a ping-ponging shine for most themes, glyph rain for the
 * phosphor one. All motion is a pure function of the frame, the mark is
 * born from nothing (frame 0 paints nothing anywhere), each cell is
 * monotonic — once painted, never erased — and the intro's final frame
 * always equals the settled loop frame, so the handoff is invisible. */
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

/** The whole opening act must finish inside a second: at 20 fps that is
 * exactly 20 frames. The intro covers frames 0..19; the loop's own clock
 * would render frame 20 with the shine band just off the left edge —
 * exactly where frame 19 hands over — so the seam is invisible. */
export const INTRO_DURATION = 20;

export interface IntroCellContext {
  /** Frames since the welcome screen appeared; 0-based, 20 fps. */
  frame: number;
  /** Total frames this intro runs before the shine loop takes over. */
  duration: number;
  /** frame / duration, 0..1 — convenience for progress-keyed reveals. */
  progress: number;
  /** Logo row, 0..5 top to bottom. */
  rowIndex: number;
  /** Logo column, 0..width-1 left to right. */
  column: number;
  /** The shine's travel axis: column + rowIndex*2. */
  diagonal: number;
  /** Largest diagonal value + 1: the diagonal extent of the mark. */
  span: number;
  /** Logo width in cells. */
  width: number;
  /** The final glyph this cell resolves to (always exactly one cell wide). */
  glyph: string;
  /** Settled gradient color of this cell (accent→heading along the diagonal). */
  base: string;
  /** Palette handles for the active theme. */
  accent: string;
  heading: string;
  headingStrong: string;
  text: string;
  /** Deterministic per-cell randomness: same seed → same value, always. */
  rnd(seed: number): number;
}

/** One rendered intro cell, or null while the cell is still unpainted. */
export type IntroCell = { glyph: string; color: string } | null;

export interface ThemeIntro {
  /** Pure per-cell renderer; same inputs must always yield the same output. */
  cell(context: IntroCellContext): IntroCell;
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

export function mix(from: string, to: string, t: number): string {
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

/** Stateless hash → [0,1), keyed by the seed alone. Chain seeds for variety. */
export function hash01(seed: number): number {
  let x = (Math.imul(seed + 1, 2654435761) ^ Math.imul(0x9e3779b9, 97531)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x45d9f3b);
  x ^= x >>> 16;
  x = Math.imul(x, 0x45d9f3b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Width of the shine's gaussian band, in diagonal cells. */
export const SHINE_BAND_WIDTH = 18;
/** Peak glow the band paints over the settled gradient. */
export const SHINE_GLOW_BOOST = 0.7;

/**
 * Center of the shine band along the diagonal axis for loop-frame u. The band
 * ping-pongs with a swaying rate: it lingers at the ends, then dashes across.
 * At u = 0 the band sits just off the left edge — the loop always re-enters
 * from the left, and the default theme's brush intro is exactly this phase's
 * first sweep, so the handoff is seamless.
 */
export function shineBandCenter(u: number, span: number): number {
  const theta = 0.04 * u + 3.5 * Math.sin(u / 170) - Math.PI / 2;
  return span / 2 + Math.sin(theta) * (span / 2 + 6);
}

/** The loop's settled cell with the shine band centered at `bandCenter`. */
function cellAtBand(context: IntroCellContext, bandCenter: number): { glyph: string; color: string } {
  const dx = context.diagonal - bandCenter;
  const glow = Math.exp(-(dx * dx) / SHINE_BAND_WIDTH);
  const intensity = Math.min(0.95, glow * SHINE_GLOW_BOOST);
  const color = intensity > 0.03 ? mix(context.base, context.headingStrong, intensity) : context.base;
  return { glyph: context.glyph, color };
}

/** The loop state an intro must land on: the shine band where it sits at the
 * moment the intro hands over. Every intro converges to this. */
function settledCell(context: IntroCellContext): { glyph: string; color: string } {
  return cellAtBand(context, shineBandCenter(context.duration, context.span));
}

/** True while the welcome intro is playing and cells should be handed to the
 * intro renderer instead of the settled shine loop. */
export function introActive(frame: number): boolean {
  return frame < INTRO_DURATION;
}

/** Deterministic global birth order for a logo cell: 0..N-1 across the whole
 * mark, from a fixed hash of the cell coordinates. Intros that key off
 * "when this cell is due" add their own shaping on top of this. */
function birthOrder(context: IntroCellContext, seed: number): number {
  const cells = context.width * 6;
  return Math.floor(hash01(Math.floor((context.rowIndex * context.width + context.column) * 7.13 + seed * 7919)) * cells);
}

/** Per-theme opening acts, keyed by theme name. Each is a pure function of
 * the frame, paints nothing at frame 0, and converges on the settled cell by
 * the handoff frame. */
const intros: Record<string, ThemeIntro> = {
  // aurora — the shine band is the brush: a reveal front sweeps left to
  // right across the mark, painting the settled palette in its wake with a
  // faint trailing sheen at the edge. The front starts off the left edge so
  // frame 0 is blank, and the colors are the settled ones, so the handoff
  // is invisible.
  aurora: {
    cell(context) {
      const front = (context.frame / (context.duration - 1)) * (context.span + 4) - 2;
      if (context.diagonal > front) return null; // ahead of the brush: still nothing
      const dx = front - context.diagonal;
      const sheen = Math.exp(-(dx * dx) / 6) * 0.45;
      const settled = settledCell(context);
      const color = sheen > 0.02 ? mix(settled.color, context.accent, sheen) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // midnight — a narrow spotlight sweeps across a black stage; each cell the
  // beam touches blazes white-hot at birth, then cools into the settled
  // palette. Left to right, one pass.
  midnight: {
    cell(context) {
      const front = context.progress * (context.span + 10) - 5;
      if (context.diagonal > front) return null;
      const dx = context.diagonal - front;
      const birth = Math.exp(-(dx * dx) / 3);
      const settled = settledCell(context);
      const color = birth > 0.02 ? mix(settled.color, '#ffffff', Math.min(1, birth * 1.4)) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // nord — an aurora curtain: a cold green-white wave washes left to right
  // through the mark, each row's edge slightly offset so the reveal ripples
  // like light on ice.
  nord: {
    cell(context) {
      const wave = context.progress * (context.span + 14) - 7;
      const jitter = (context.rnd(1) - 0.5) * 5 + context.rowIndex * 2.2;
      const edge = wave + jitter;
      if (context.diagonal > edge) return null;
      const dx = context.diagonal - edge;
      const glow = Math.exp(-(dx * dx) / 6);
      const settled = settledCell(context);
      const color = glow > 0.02 ? mix(settled.color, '#a8ffda', glow * 0.8) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // dracula — an ink bleed: dark violet droplets surface at fixed points and
  // spread outward as circles until the mark is flooded; each cell is born
  // wet-glossy pink and dries into the settled gradient.
  dracula: {
    cell(context) {
      const seeds = [3, 11, 23, 37, 53];
      let born: number | undefined;
      for (const seed of seeds) {
        const cx = context.rnd(seed * 2) * context.span;
        const cy = context.rnd(seed * 3) * 6;
        const dist = Math.hypot(context.diagonal - cx, (context.rowIndex - cy) * 1.6);
        const start = context.rnd(seed) * 0.3;
        const reach = start + (dist / Math.max(1, context.span * 0.75)) * 0.6;
        if (context.progress >= reach && (born === undefined || reach < born)) born = reach;
      }
      if (born === undefined) return null;
      const wet = Math.max(0, 1 - (context.progress - born) / 0.14);
      const settled = settledCell(context);
      const color = wet > 0 ? mix(settled.color, '#ff79c6', wet * 0.75) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // dawn — a sunrise: cells wake from the bottom row upward, each igniting
  // gold as the light line passes and cooling into the settled pastel.
  dawn: {
    cell(context) {
      const due = 0.06 + ((5 - context.rowIndex) / 6) * 0.72 + (context.rnd(2) - 0.5) * 0.06;
      if (context.progress < due) return null;
      const heat = Math.max(0, 1 - (context.progress - due) / 0.15);
      const settled = settledCell(context);
      const color = heat > 0.02 ? mix(settled.color, '#ffb347', heat * 0.7) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // solarized — a darkroom print developing: cells surface as a faint cyan
  // ghost that deepens into full contrast, center cells first like a
  // vignette developing from the middle out.
  solarized: {
    cell(context) {
      const vignette = 1 - Math.abs(context.diagonal - context.span / 2) / context.span;
      const due = 0.1 + (1 - vignette) * 0.5;
      if (context.progress < due) return null;
      const develop = Math.min(1, (context.progress - due) / 0.2);
      const settled = settledCell(context);
      return { glyph: context.glyph, color: mix(mix(context.accent, '#000000', 0.8), settled.color, develop) };
    },
  },

  // rose-pine — petals fall: pale rose petals drift down through the mark's
  // bounding box and stick where they land, filling the letterforms from
  // random contact points until every cell has settled.
  'rose-pine': {
    cell(context) {
      const seeds = [7, 19, 31, 43, 59, 71];
      let landed: number | undefined;
      for (const seed of seeds) {
        const drift = context.rnd(seed) * context.span;
        const delay = context.rnd(seed * 5) * 0.24;
        const fall = delay + (1 - (context.rowIndex + (context.rnd(seed * 3) - 0.5) * 2) / 6) * 0.4;
        if (context.progress >= fall && Math.abs(context.diagonal - drift) < 7 + context.progress * 10) {
          if (landed === undefined || fall < landed) landed = fall;
        }
      }
      if (landed === undefined) return null;
      const settle = Math.max(0, 1 - (context.progress - landed) / 0.12);
      const settled = settledCell(context);
      const color = settle > 0 ? mix(settled.color, '#eb6f92', settle * 0.65) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // tokyo-night — neon ignition: the sign flickers on like a faulty neon
  // tube — cells pop in a random order, sputtering briefly before holding
  // steady.
  'tokyo-night': {
    cell(context) {
      const due = 0.04 + (birthOrder(context, 13) / (context.width * 6)) * 0.62;
      if (context.progress < due) return null;
      const fresh = context.progress - due;
      if (fresh < 0.14) {
        const sputter = context.rnd(Math.floor(fresh * 140) * 13 + context.rowIndex * 31 + context.column);
        const settled = settledCell(context);
        // A dying tube dims to near-black instead of vanishing: the cell
        // stays painted, the neon still reads as sputtering.
        if (sputter < 0.4) return { glyph: context.glyph, color: mix(settled.color, '#16161e', 0.88) };
        return { glyph: context.glyph, color: mix(settled.color, '#7dcfff', 0.5) };
      }
      return settledCell(context);
    },
  },

  // catppuccin-mocha — a ripple: a soft ring expands from the center of the
  // mark, painting cells as it passes and leaving a brief pastel afterglow.
  'catppuccin-mocha': {
    cell(context) {
      const ring = context.progress * (context.span * 0.75 + 8);
      const dist = Math.hypot(context.diagonal - context.span / 2, (context.rowIndex - 2.5) * 2.4);
      if (dist > ring) return null;
      const afterglow = Math.max(0, 1 - (ring - dist) / 7);
      const settled = settledCell(context);
      const color = afterglow > 0.02 ? mix(settled.color, '#cba6f7', afterglow * 0.55) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // catppuccin-latte — a coffee pour: the cup fills bottom-up like an
  // espresso being pulled, the surface line wobbling as it rises; each
  // dunked cell flashes with a steamed-milk sheen that fades back into
  // the settled pastel as the surface moves on.
  'catppuccin-latte': {
    cell(context) {
      const level = -0.4 + context.progress * 6 + Math.sin(context.progress * 12 + context.column / 6) * 0.2;
      if (context.rowIndex + (context.rnd(4) - 0.5) * 0.5 > level) return null;
      const flash = Math.exp(-Math.max(0, level - context.rowIndex) / 1.5);
      const settled = settledCell(context);
      const color = flash > 0.02 ? mix(settled.color, context.accent, flash * 0.6) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // gruvbox-dark — a CRT power-on: the mark snaps in as a horizontal line
  // that stretches vertically from the center outward, phosphor-bright at
  // the growing edges, then relaxes into the settled warm palette.
  'gruvbox-dark': {
    cell(context) {
      const half = context.progress * 4.2;
      if (Math.abs(context.rowIndex - 2.5) > half) return null;
      const edge = Math.abs(Math.abs(context.rowIndex - 2.5) - half);
      const bloom = edge < 0.9 ? 1 - edge / 0.9 : 0;
      const settled = settledCell(context);
      const color = bloom > 0 ? mix(settled.color, '#fe8019', bloom * 0.8) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // one-dark — a typewriter: the mark is typed cell by cell, left to right,
  // top to bottom, each keystroke landing full-strength with no fade.
  'one-dark': {
    cell(context) {
      const order = context.rowIndex * context.width + context.column;
      const total = 6 * context.width;
      const typed = Math.floor((context.progress / 0.94) * total);
      if (order >= typed) return null; // strictly after 0: nothing is typed at frame 0
      const settled = settledCell(context);
      const fresh = order === typed - 1 ? 1 : 0;
      const color = fresh ? mix(settled.color, '#98c379', 0.45) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // monokai — a pixel mosaic: cells pop in as dim colored blocks in random
  // order, dwell a few ticks scintillating, then resolve one by one into
  // the true glyph with a brief bright flash.
  monokai: {
    cell(context) {
      const pop = 0.05 + (birthOrder(context, 9) / (context.width * 6)) * 0.55;
      if (context.progress <= pop) return null;
      const resolve = pop + 0.18;
      const settled = settledCell(context);
      if (context.progress <= resolve) {
        const tick = Math.floor(context.progress * context.duration / 4);
        const shades = ['░', '▒', '▓'];
        return { glyph: shades[Math.floor(context.rnd(tick * 3 + 2) * 3)]!, color: mix(context.base, '#1e1f1c', 0.55 + context.rnd(5) * 0.25) };
      }
      const flash = Math.max(0, 1 - (context.progress - resolve) / 0.08);
      const color = flash > 0 ? mix(settled.color, '#f8f8f2', flash * 0.85) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // kanagawa — a sumi-e wash: a wide soft brush draws the mark in three
  // passes (top, middle, bottom bands), each stroke wet and dark at the
  // front, drying lighter toward the tail.
  kanagawa: {
    cell(context) {
      const band = Math.floor(context.rowIndex / 2);
      const strokeFront = (context.progress * 1.15 - band * 0.22) * (context.span + 8) - 4;
      if (context.diagonal > strokeFront) return null;
      const dx = context.diagonal - strokeFront;
      const wet = Math.exp(-(dx * dx) / 26);
      const settled = settledCell(context);
      const color = wet > 0.02 ? mix(settled.color, '#1f1f28', Math.min(0.5, wet * 0.5)) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // everforest — fog lift: dense pale fog envelops nothing yet — the fog
  // edge retreats to the left as time passes, and cells emerge in its wake
  // from the right. Each cell brightens as the haze burns off.
  everforest: {
    cell(context) {
      const drift = context.progress * (context.span + 16) - 8;
      const wisp = (context.rnd(6) - 0.5) * 6 + context.rowIndex * 1.7;
      if (context.diagonal > drift + wisp) return null;
      const thin = Math.max(0, 1 - (drift + wisp - context.diagonal) / 8);
      const settled = settledCell(context);
      const color = thin > 0.02 ? mix(settled.color, '#d3c6aa', thin * 0.5) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // synthwave — VHS tear-in: the mark materializes out of tracking noise,
  // rows tearing in top to bottom with chromatic aberration, stabilizing
  // row by row until the tape locks.
  synthwave: {
    cell(context) {
      const rowLock = 0.06 + (context.rowIndex / 6) * 0.6;
      if (context.progress < rowLock) return null;
      const tear = Math.max(0, 1 - (context.progress - rowLock) / 0.14);
      if (tear > 0 && context.rnd(Math.floor(context.progress * context.duration) * 17 + context.rowIndex * 41) < tear * 0.5) return null;
      const settled = settledCell(context);
      const chroma = tear > 0 ? tear * 0.6 : 0;
      const color = chroma > 0 ? mix(settled.color, chroma * 2 > 1 ? '#36f9f6' : '#fe4450', chroma) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // matrix — rain condensation: glyph rain falls through the mark's bounding
  // box and the letterforms condense where the rain strikes, as if the code
  // itself is condensing out of the downpour.
  matrix: {
    cell(context) {
      const strike = 0.06 + context.rnd(8) * 0.6;
      if (context.progress < strike) return null;
      const settle = Math.max(0, 1 - (context.progress - strike) / 0.1);
      const settled = settledCell(context);
      const color = settle > 0 ? mix(settled.color, '#c8ffd9', settle * 0.7) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // solarized-light — blueprint develop: a scanning bar sweeps down over
  // blank paper; behind it the ink darkens rapidly from nothing into the
  // finished solarized-light palette.
  'solarized-light': {
    cell(context) {
      const scan = -1.5 + context.progress * 9;
      if (context.rowIndex > scan) return null;
      const fresh = Math.max(0, 1 - (context.rowIndex - scan) / 1.4);
      const settled = settledCell(context);
      const color = fresh > 0.02 ? mix(settled.color, '#268bd2', fresh * 0.6) : settled.color;
      return { glyph: context.glyph, color };
    },
  },

  // github-light — skeleton shimmer: a pale wireframe flickers in for a
  // couple of beats, then the fill floods in left to right with a crisp
  // leading edge, converting the skeleton in place — nothing is ever
  // erased — ending at full contrast.
  'github-light': {
    cell(context) {
      const settled = settledCell(context);
      const skeleton = { glyph: context.glyph, color: mix('#f6f8fa', '#d0d7de', 0.4) };
      if (context.progress < 0.02) return null;
      if (context.progress < 0.28) {
        // The wireframe breathes: bright beats and dim beats, but a cell
        // stays painted once it has first appeared.
        const sputter = context.rnd(Math.floor(context.progress * 100) * 29 + context.rowIndex * 17 + context.column);
        if (sputter < 0.45) return { glyph: context.glyph, color: mix('#f6f8fa', '#d0d7de', 0.75) };
        return skeleton;
      }
      const front = (context.progress - 0.28) / 0.72 * (context.span + 6) - 3;
      if (context.diagonal > front) return skeleton; // not yet flooded: skeleton holds
      const fresh = Math.max(0, 1 - (front - context.diagonal) / 4);
      const color = fresh > 0.02 ? mix(settled.color, '#0969da', fresh * 0.5) : settled.color;
      return { glyph: context.glyph, color };
    },
  },
};

export function renderWelcome(width: number, height: number, terminalHeight = height, frame = 0): string[] {
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  const rows = Array.from({ length: height }, () => '');
  const center = Math.max(0, Math.min(height - 1, Math.floor((terminalHeight - 1) / 2)));
  const palette = activeTuiTheme().markdown;
  const cycle = frame % 80;
  const logoTop = center - 3;
  if (width >= LOGO_WIDTH + 3 && logoTop >= 0 && logoTop + LOGO.length <= height) {
    const rise = 2;
    const span = LOGO_WIDTH + rise * (LOGO.length - 1);
    // Loop phase: the shine ping-pongs with a swaying rate, re-entering from
    // the left each cycle, so the band lingers at the ends then dashes across.
    const bandCenter = shineBandCenter(frame, span);
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
    const themeName = activeTuiTheme().name;
    const intro = intros[themeName];
    LOGO.forEach((template, rowIndex) => {
      const row = logoTop + rowIndex;
      let line = '';
      for (let column = 0; column < LOGO_WIDTH; column++) {
        const diagonal = column + rowIndex * rise;
        const glyph = template[column]!;
        if (glyph === ' ') {
          line += rainAt(row, leftCells + column);
          continue;
        }
        const base = mix(palette.accent, palette.heading, diagonal / span);
        if (intro && introActive(frame)) {
          const context: IntroCellContext = {
            frame,
            duration: INTRO_DURATION,
            progress: frame / INTRO_DURATION,
            rowIndex,
            column,
            diagonal,
            span,
            width: LOGO_WIDTH,
            glyph,
            base,
            accent: palette.accent,
            heading: palette.heading,
            headingStrong: palette.headingStrong,
            text: palette.text,
            rnd: (seed: number) => hash01(seed * 7919 + rowIndex * 131 + column * 7 + 5),
          };
          const painted: IntroCell = intro.cell(context);
          if (painted) line += `{${painted.color}-fg}${painted.glyph}{/${painted.color}-fg}`;
          continue;
        }
        // Loop: the settled gradient with the shine riding on top.
        const dx = diagonal - bandCenter;
        const glow = Math.exp(-(dx * dx) / SHINE_BAND_WIDTH);
        const intensity = Math.min(0.95, glow * SHINE_GLOW_BOOST);
        const color = intensity > 0.03 ? mix(base, palette.headingStrong, intensity) : base;
        line += `{${color}-fg}${glyph}{/${color}-fg}`;
      }
      rows[row] = `${rainPad(row, 0, leftCells)}${line}${rainPad(row, leftCells + LOGO_WIDTH, width)}`;
    });
    const brandRow = logoTop + LOGO.length + 1;
    if (brandRow < height && BRAND.length <= width) {
      const brandLeft = Math.floor((width - BRAND.length) / 2);
      const brand = `{${palette.headingStrong}-fg}{bold}{/bold}{/${palette.headingStrong}-fg}{white-fg}{bold}${BRAND}{/bold}{/white-fg}`;
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
