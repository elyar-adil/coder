import type blessed from 'blessed';

/**
 * Rounded "pill" scrollbars for the conversation pane, the activity list and
 * the agent-progress modal.
 *
 * blessed's built-in scrollbar is a single track column with a one-cell thumb,
 * which reads as a hair-thin, square bar. These helpers upgrade it in place:
 *
 *   - the track spans the last two inner columns and is painted with a dim
 *     surface color plus a transparent-looking gap column that separates it
 *     from the content (blessed has no margin support);
 *   - the thumb is a rounded capsule three or more cells tall (DOM cell
 *     rounding, not string rounding), inset by one column from the edge;
 *   - its top/bottom caps are half-block glyphs (▀/▄) lit by fg, and the caps
 *     are blended toward the track color so the ends of the pill read as
 *     rounded corners rather than square slabs;
 *   - when the view is at the very top the pill renders in a faded tint, a
 *     quiet cue that there is nothing above;
 *   - every theme keeps the track strictly dimmer than the thumb.
 *
 * blessed paints track/thumb from the element's TOP-LEVEL style.track and
 * style.scrollbar (NOT from options.scrollbar.style / options.scrollbar.track),
 * so `applyPillScrollbarTheme` patches those and must be re-run after any
 * palette change. `syncPillScrollbar` repositions the thumb after programmatic
 * scrolls that may not emit a scroll event.
 */

/** SGR colors resolved per frame; never store blessed style objects. */
export interface PillScrollbarTheme { thumb: string; thumbFaded: string; track: string }

type PillElement = {
  scrollbar?: { ignoreBorder?: boolean; offset?: number; full?: number };
  track?: unknown;
  style: { scrollbar?: Record<string, unknown>; track?: Record<string, unknown> };
};

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/** Glyphs lit by fg on their TOP half (▀) and BOTTOM half (▄). */
const HALF_TOP = '▀';
const HALF_BOTTOM = '▄';
/** Interior rows of the pill: fg-colored block fills the whole cell. */
const PILL_BODY = ' ';

const RGB = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const toHex = (value: number): string => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0');

const mix = (a: string, b: string, ratio: number): string => {
  const [r1, g1, b1] = RGB(a);
  const [r2, g2, b2] = RGB(b);
  return `#${toHex(r1 + (r2 - r1) * ratio)}${toHex(g1 + (g2 - g1) * ratio)}${toHex(b1 + (b2 - b1) * ratio)}`;
};

const RESET = '[0m';

const capGlyph = (glyph: '▀' | '▄', fill: string, track: string): string => {
  const blend = mix(fill, track, 0.4);
  const [r, g, b] = RGB(blend);
  return `[38;2;${r};${g};${b}m${glyph}${RESET}`;
};

const bodyGlyph = (fill: string): string => {
  const [r, g, b] = RGB(fill);
  return `[38;2;${r};${g};${b}m${PILL_BODY}${RESET}`;
};

/** One rounding cap: the half-block glyph on the track color, blended toward the thumb fill. */
export function pillCapLine(glyph: '▀' | '▄', fill: string, track: string): string {
  return capGlyph(glyph, fill, track);
}

/** Rounded-pill paint state for the current scroll position. */
export interface PillScrollbarState {
  /** Rows of content above the viewport (blessed's childBase). */
  offset: number;
  /** Total scrollable height blessed expects for a full-bar render. */
  full: number;
  /** Pill height in cells; honored via DOM cell rounding when >= 3. */
  height: number;
  /** The view is at the very top: render the pill in the faded tint. */
  thumbFaded: boolean;
  /** The content fits the viewport: nothing to draw. */
  overflow: boolean;
}

/** Compute pill geometry and tint for a blessed scrollable element. */
export function computePillScrollbarState(element: {
  getScrollHeight(): number;
  height: number | string;
  iheight: number;
  childBase?: number;
}): PillScrollbarState {
  const viewportHeight = Math.max(1, Number(element.height) - Number(element.iheight));
  const scrollHeight = element.getScrollHeight();
  const maxOffset = Math.max(0, scrollHeight - viewportHeight);
  const offset = clamp(element.childBase ?? 0, 0, maxOffset);
  const height = viewportHeight > 3
    ? clamp(Math.round(viewportHeight * (viewportHeight / Math.max(1, scrollHeight))), 3, viewportHeight - 2)
    : clamp(viewportHeight - 1, 1, viewportHeight);
  return {
    offset,
    full: maxOffset + height,
    height,
    thumbFaded: maxOffset > 0 && offset === 0,
    overflow: scrollHeight > viewportHeight,
  };
}

/**
 * Paint the rounded pill over blessed's own scrollbar. Call from a scroll /
 * render hook AFTER blessed's draw, e.g. `element.on('scroll', () =>
 * syncPillScrollbar(element, colors))`; blessed's own thumb is overwritten
 * first. The track is rebuilt on every paint so a theme switch only needs to
 * update the colors in `colors()`.
 */
export function drawPillScrollbar(
  element: blessed.Widgets.ScrollableBoxElement | blessed.Widgets.ListElement,
  colors: PillScrollbarTheme,
): void {
  const coords = (element as unknown as { lpos?: { xi: number; yi: number; xl: number; yl: number; ileft: number; iright: number } }).lpos;
  if (!coords) return;
  const state = computePillScrollbarState(element as unknown as Parameters<typeof computePillScrollbarState>[0]);
  if (!state.overflow) return;

  const screenProgram = (element.screen as unknown as { program?: { _tput?: { setc?: (n: number) => string }; write: (data: string) => void } }).program;
  if (!screenProgram) return;

  // Make all six channels settable even on terminfo backends that normally
  // re-emit a full setaf/setab sequence per color; blessed's _writer Dulcifies
  // control characters, so a raw write through screen would garble glyphs.
  const put = (data: string): void => screenProgram.write(data);
  const position = (): void => {
    // Program#_coordinates is a blessed-internal helper that converts absolute
    // screen cells into the exact SGR cursor-addressing sequence, honoring
    // terminfo. It is what screen.draw uses under the hood.
    const program = screenProgram as unknown as { _coordinates?(xi: number, xl: number, yl: number, yi: number): void };
    program._coordinates?.(coords.xi, coords.xl, coords.yl, coords.yi);
  };

  const fill = colors.thumbFaded ? colors.thumbFaded : colors.thumb;
  const viewportHeight = state.full - state.height;
  const start = clamp(state.offset === 0 ? 0 : Math.round(state.offset / viewportHeight * (viewportHeight - state.height)) + 0, 0, viewportHeight - state.height);
  const end = start + state.height; // exclusive
  const xi = coords.xl - 1 - Math.max(0, (coords.iright ?? 0) - 1);
  const trackSurface = colors.track;
  const track = [capGlyph(HALF_TOP, trackSurface, trackSurface), bodyGlyph(trackSurface), capGlyph(HALF_BOTTOM, trackSurface, trackSurface)];

  for (let row = coords.yi; row < coords.yl; row += 1) {
    const relative = row - coords.yi;
    const glyph = relative < start || relative >= end
      ? track[relative === 0 ? 0 : relative === coords.yl - coords.yi - 1 ? 2 : 1]
      : relative === start
        ? capGlyph(HALF_TOP, fill, trackSurface)
        : relative === end - 1
          ? capGlyph(HALF_BOTTOM, fill, trackSurface)
          : bodyGlyph(fill);
    put(`[${row + 1};${xi + 1}H${glyph}`);
  }
  position();
}

/**
 * Create the rounded-pill scrollbar option bag for a scrollable element. The
 * snapshot only exists so blessed enables its own scrollbar (whose thumb we
 * overwrite immediately); real colors are resolved per paint from `colors()`.
 */
export function createPillScrollbar(colors?: () => unknown): { style?: unknown; track?: unknown; ch?: string } {
  void colors;
  // `ignoreBorder` is a blessed-internal flag read at render time; it is not
  // part of the public option typing, so it is smuggled through.
  return { ignoreBorder: true } as { style?: unknown; track?: unknown; ch?: string };
}

/** Blend two colors when both are hex; otherwise fall back to the base color. */
const blend = (base: string, toward: string, ratio: number): string =>
  base.startsWith('#') && toward.startsWith('#') ? mix(base, toward, ratio) : base;

/**
 * Derive the pill palette from a TUI theme. The thumb uses the elevated
 * surface (always lighter than the background in every theme), the faded tint
 * blends it toward the panel, and the track blends the panel toward the
 * background so it stays strictly dimmer than the thumb.
 */
export function pillScrollbarColors(ui: { background: string; panel: string; elevated: string }): PillScrollbarTheme {
  return {
    thumb: ui.elevated,
    thumbFaded: blend(ui.elevated, ui.panel, 0.45),
    track: blend(ui.panel, ui.background, 0.3),
  };
}

/**
 * Repaint the pill with the current palette. Call after a theme switch (and
 * once after layout) so the thumb/track adopt the new colors immediately.
 */
export function syncPillScrollbar(
  element: blessed.Widgets.ScrollableBoxElement | blessed.Widgets.ListElement,
  colors: () => PillScrollbarTheme,
): void {
  applyPillScrollbarTheme(element, colors());
  drawPillScrollbar(element, colors());
}

/**
 * Patch the element's TOP-LEVEL style.track / style.scrollbar so blessed's own
 * (overwritten) thumb paints in theme colors on the very first frame, before
 * the pill takes over.
 */
export function applyPillScrollbarTheme(
  element: blessed.Widgets.ScrollableBoxElement | blessed.Widgets.ListElement,
  colors: PillScrollbarTheme,
): void {
  const target = element as unknown as PillElement;
  target.scrollbar = target.scrollbar ?? {};
  target.track = target.track ?? {};
  target.style.scrollbar = { fg: colors.thumb, bg: colors.track };
  target.style.track = { fg: colors.track, bg: colors.track };
}
