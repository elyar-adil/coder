import blessed from 'blessed';

/**
 * Rounded "pill" scrollbars for the conversation pane, the activity list and
 * the agent-progress modal.
 *
 * blessed's built-in scrollbar is a single track column with a one-cell thumb,
 * which reads as a hair-thin, square bar — and it repaints on every render,
 * fighting any raw-SGR attempt to draw over it. Instead of drawing over
 * blessed, we disable blessed's own scrollbar entirely and render the pill as
 * a real overlay element parented to the screen:
 *
 *   - because the pill is an element, it composes with every screen.render()
 *     pass, survives theme switches and resize, and needs no render hooks or
 *     post-render writes;
 *   - the thumb is a rounded capsule three or more cells tall: half-block
 *     glyph caps (▀/▄) blended toward the track color, solid block body;
 *   - when the view is at the very top the pill renders in a faded tint, a
 *     quiet cue that there is nothing above;
 *   - the overlay forwards wheel events to the tracked element and page-jumps
 *     on click, so the column stays fully interactive;
 *   - every theme keeps the track strictly dimmer than the thumb.
 */

/** SGR colors resolved per sync; never store blessed style objects. */
export interface PillScrollbarTheme { thumb: string; thumbFaded: string; track: string }

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/** Glyphs lit by fg on their TOP half (▀) and BOTTOM half (▄). */
const HALF_TOP = '▀';
const HALF_BOTTOM = '▄';
/** Interior rows of the pill: fg-colored block fills the whole cell. */
const PILL_BODY = '█';

const RGB = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const toHex = (value: number): string => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0');

/** Blend two hex colors; when either is a named color, fall back to the base. */
export const blend = (base: string, toward: string, ratio: number): string => {
  if (!base.startsWith('#') || !toward.startsWith('#')) return base;
  const [r1, g1, b1] = RGB(base);
  const [r2, g2, b2] = RGB(toward);
  return `#${toHex(r1 + (r2 - r1) * ratio)}${toHex(g1 + (g2 - g1) * ratio)}${toHex(b1 + (b2 - b1) * ratio)}`;
};

/**
 * Derive the pill palette from a TUI theme. The thumb uses the elevated
 * surface (lighter than the background in every theme), the faded tint blends
 * it toward the panel, and the track blends the panel toward the background so
 * it stays strictly dimmer than the thumb.
 */
export function pillScrollbarColors(ui: { background: string; panel: string; elevated: string }): PillScrollbarTheme {
  return {
    thumb: ui.elevated,
    thumbFaded: blend(ui.elevated, ui.panel, 0.45),
    track: blend(ui.panel, ui.background, 0.3),
  };
}

type ScrollableElement = blessed.Widgets.ScrollableBoxElement | blessed.Widgets.ListElement;

type Lpos = { xi: number; xl: number; yi: number; yl: number };

/**
 * Compute pill geometry for a rendered scrollable element. Returns null when
 * the element is off-screen or its content fits the viewport.
 */
export function computePillScrollbarState(
  element: ScrollableElement,
  lpos: Lpos,
): { offset: number; maxOffset: number; viewportHeight: number; thumbHeight: number; thumbStart: number; faded: boolean } | null {
  const viewportHeight = Math.max(1, lpos.yl - lpos.yi - Number(element.iheight));
  const scrollHeight = element.getScrollHeight();
  const maxOffset = scrollHeight - viewportHeight;
  if (maxOffset <= 0) return null;
  const offset = clamp(element.childBase ?? 0, 0, maxOffset);
  const thumbHeight = clamp(Math.round(viewportHeight * (viewportHeight / scrollHeight)), 3, viewportHeight);
  const travel = viewportHeight - thumbHeight;
  const thumbStart = clamp(Math.round((offset / maxOffset) * travel), 0, travel);
  return { offset, maxOffset, viewportHeight, thumbHeight, thumbStart, faded: offset === 0 };
}

export interface PillScrollbarHandle {
  /** Recompute position/visibility/content from the element's current state. */
  sync(): void;
  destroy(): void;
}

/**
 * Attach a pill overlay to a scrollable element. blessed's own scrollbar is
 * not used — do NOT pass a `scrollbar` option to the element. The returned
 * handle must be `sync()`ed after layout/content changes (before
 * `screen.render()`) and `destroy()`ed with its owner.
 */
export function attachPillScrollbar(element: ScrollableElement, colors: () => PillScrollbarTheme): PillScrollbarHandle {
  const overlay = blessed.box({
    parent: element.screen, tags: true, width: 1, height: 1, hidden: true, mouse: true,
    style: {},
  });

  const sync = (): void => {
    const lpos = element.lpos as unknown as Lpos | undefined;
    if (element.hidden || element.detached || !lpos) {
      overlay.hide();
      return;
    }
    const state = computePillScrollbarState(element, lpos);
    if (!state) {
      overlay.hide();
      return;
    }
    overlay.show();
    overlay.left = lpos.xl - 1;
    overlay.top = lpos.yi + Number(element.itop);
    overlay.width = 1;
    overlay.height = state.viewportHeight;
    const c = colors();
    const fill = state.faded ? c.thumbFaded : c.thumb;
    const cap = blend(fill, c.track, 0.4);
    overlay.style.bg = c.track;
    const lines: string[] = [];
    for (let row = 0; row < state.viewportHeight; row += 1) {
      if (row < state.thumbStart || row >= state.thumbStart + state.thumbHeight) {
        lines.push(' ');
      } else if (row === state.thumbStart) {
        lines.push(`{${cap}-fg}${HALF_TOP}{/}`);
      } else if (row === state.thumbStart + state.thumbHeight - 1) {
        lines.push(`{${cap}-fg}${HALF_BOTTOM}{/}`);
      } else {
        lines.push(`{${fill}-fg}${PILL_BODY}{/}`);
      }
    }
    overlay.setContent(lines.join('\n'));
  };

  element.on('scroll', sync);
  element.on('resize', sync);
  element.on('hide', () => overlay.hide());
  element.on('detach', () => overlay.hide());

  // The overlay column stays interactive: wheel scrolls the tracked element,
  // click jumps proportionally to the click position.
  overlay.on('wheelup', () => element.scroll(-3));
  overlay.on('wheeldown', () => element.scroll(3));
  overlay.on('click', (data: { x?: number; y?: number }) => {
    const lpos = element.lpos as unknown as Lpos | undefined;
    const state = lpos ? computePillScrollbarState(element, lpos) : null;
    if (!lpos || !state) return;
    const ratio = clamp(((data.y ?? lpos.yi) - lpos.yi) / Math.max(1, state.viewportHeight), 0, 1);
    element.scrollTo(Math.round(ratio * state.maxOffset));
  });

  return {
    sync,
    destroy: () => overlay.destroy(),
  };
}
