import blessed from 'blessed';

/**
 * Gradient "pill" scrollbars for the conversation pane, the activity list and
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
 *   - the thumb is a soft intensity field with a short decaying trail, so the
 *     capsule glides between rows instead of jumping as a rigid gradient block;
 *   - the soft feather and trail exist only while the pill is moving — at rest
 *     the capsule is a fully opaque gradient with crisp half-row caps;
 *   - the thumb position follows scroll events with a critically damped
 *     spring, so fast scrolling and click-jumps glide instead of teleporting;
 *   - hovering the column brightens the pill and pulls the feather in, a
 *     quiet affordance that the column is interactive;
 *   - when the view is at the very top the pill renders in a faded tint, a
 *     quiet cue that there is nothing above;
 *   - the overlay forwards wheel events to the tracked element and page-jumps
 *     on click, so the column stays fully interactive;
 *   - every theme keeps the track strictly dimmer than the thumb.
 */

/** SGR colors resolved per sync; never store blessed style objects. */
export interface PillScrollbarTheme {
  thumb: string;
  thumbFaded: string;
  track: string;
  /** Optional low-contrast glyph used to texture the track between the pill. */
  trackPattern?: string;
  trackPatternColor?: string;
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/** One-cell glyph set used to build the capsule at half-row resolution. */
const PILL_BODY = '█';
const HALF_TOP = '▀';
const HALF_BOTTOM = '▄';

/** Number of content rows advanced by one wheel notch on the scrollbar. */
const WHEEL_SCROLL_LINES = 1;

/** On hover the feather is pulled in so the pill reads fuller and brighter. */
const HOVER_FEATHER_SCALE = 0.7;
const HOVER_BRIGHTEN = 0.16;
const TRAIL_DECAY = 0.86;

/** Spring constants (per 16ms frame): stiffness pulls, damping settles. */
const FRAME_MS = 16;
const SPRING_STIFFNESS = 0.16;
const SPRING_DAMPING = 0.72;
const SPRING_SETTLE = 0.02;

const RGB = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const toHex = (value: number): string => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0');

/** ANSI theme names need RGB equivalents for smooth per-row interpolation. */
const ANSI_RGB: Record<string, string> = {
  black: '#000000', gray: '#808080', white: '#c0c0c0',
  'light-black': '#808080', 'light-white': '#ffffff',
  red: '#800000', 'light-red': '#ff5555', green: '#008000', 'light-green': '#55ff55',
  yellow: '#808000', 'light-yellow': '#ffff55', blue: '#000080', 'light-blue': '#5555ff',
  magenta: '#800080', 'light-magenta': '#ff55ff', cyan: '#008080', 'light-cyan': '#55ffff',
};

const rgbColor = (color: string): string => color.startsWith('#') ? color : ANSI_RGB[color.toLowerCase()] ?? color;

/** Blend two hex colors; when either is a named color, fall back to the base. */
export const blend = (base: string, toward: string, ratio: number): string => {
  if (!base.startsWith('#') || !toward.startsWith('#')) return base;
  const [r1, g1, b1] = RGB(base);
  const [r2, g2, b2] = RGB(toward);
  return `#${toHex(r1 + (r2 - r1) * ratio)}${toHex(g1 + (g2 - g1) * ratio)}${toHex(b1 + (b2 - b1) * ratio)}`;
};

const luminance = (hex: string): number => {
  if (!hex.startsWith('#')) return 0.5;
  const [r, g, b] = RGB(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

/** Nudge a color brighter on dark themes and darker on light ones. */
const boost = (hex: string, ratio: number): string => blend(hex, luminance(hex) >= 0.5 ? '#000000' : '#ffffff', ratio);

/**
 * Derive the pill palette from a TUI theme. The capsule follows the theme's
 * accent color, while the track remains a quiet panel/background surface. A
 * sparse dot pattern gives the otherwise empty track a little definition.
 */
export function pillScrollbarColors(ui: {
  background: string;
  panel: string;
  elevated: string;
  accent?: string;
  subtle?: string;
  line?: string;
}): PillScrollbarTheme {
  const thumb = rgbColor(ui.accent ?? ui.elevated);
  const fadedBase = rgbColor(ui.subtle ?? ui.panel);
  const patternBase = rgbColor(ui.subtle ?? ui.line ?? ui.panel);
  const panel = rgbColor(ui.panel);
  const background = rgbColor(ui.background);
  const fadedBlend = blend(thumb, fadedBase, 0.5);
  return {
    thumb,
    // Named terminal colors cannot be blended numerically; fall back to the
    // theme's quieter surface so the top-of-scroll state still reads faded.
    thumbFaded: fadedBlend === thumb && fadedBase !== thumb ? fadedBase : fadedBlend,
    track: blend(panel, background, 0.3),
    trackPattern: '·',
    trackPatternColor: blend(patternBase, ui.background, 0.45),
  };
}

type ScrollableElement = blessed.Widgets.ScrollableBoxElement | blessed.Widgets.ListElement;

type Lpos = { xi: number; xl: number; yi: number; yl: number };

type PillState = {
  offset: number;
  maxOffset: number;
  viewportHeight: number;
  thumbHeight: number;
  thumbStart: number;
  faded: boolean;
};

/**
 * Compute pill geometry for a rendered scrollable element. Returns null when
 * the element is off-screen or its content fits the viewport.
 */
export function computePillScrollbarState(
  element: ScrollableElement,
  lpos: Lpos,
): PillState | null {
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

  let hover = false;
  /** Spring position of the pill's top edge in rows; null until first shown. */
  let visual: number | null = null;
  let velocity = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastState: PillState | null = null;
  let trail: number[] = [];
  /** Brightest leftover trail ghost from the last paint; 0 when settled. */
  let residue = 0;
  let dragging = false;
  let dragOffset = 0;
  let movedDuringDrag = false;

  const stopTimer = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const sleep = (): void => {
    stopTimer();
    visual = null;
    velocity = 0;
    lastState = null;
    trail = [];
    residue = 0;
  };

  const targetOf = (state: PillState): number => {
    const travel = state.viewportHeight - state.thumbHeight;
    return state.maxOffset > 0 ? clamp((state.offset / state.maxOffset) * travel, 0, travel) : 0;
  };

  const smoothstep = (value: number): number => {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  };

  const paint = (state: PillState, top: number): void => {
    lastState = state;
    const c = colors();
    const fill = hover ? boost(state.faded ? c.thumbFaded : c.thumb, HOVER_BRIGHTEN) : (state.faded ? c.thumbFaded : c.thumb);
    const featherScale = hover ? HOVER_FEATHER_SCALE : 1;
    // Motion (spring velocity plus remaining distance) drives the feather and
    // the trail; at rest both collapse so the capsule is fully opaque.
    const motion = clamp(Math.abs(velocity) * 10 + Math.abs(targetOf(state) - top) * 1.5, 0, 1);
    overlay.style.bg = c.track;
    const maxTop = Math.max(0, state.viewportHeight - state.thumbHeight);
    const start = clamp(top, 0, maxTop);
    const center = start + state.thumbHeight / 2;
    const halfLength = state.thumbHeight / 2;
    const feather = Math.max(0.06, motion * 1.15 * featherScale);
    // Store two samples per terminal row. A half-block cell can display an
    // independent foreground (top half) and background (bottom half), which
    // doubles the scrollbar's vertical resolution without changing its width.
    if (trail.length !== state.viewportHeight * 2) trail = Array.from({ length: state.viewportHeight * 2 }, () => 0);
    // Residue is how much painted brightness exceeds the live intensity —
    // i.e. leftover trail ghosting. The animation keeps running until it
    // drains, so a pill that just stopped never rests with a faded tail.
    residue = 0;
    const sample = (position: number, index: number): number => {
      const distance = Math.abs(position - center);
      const edge = (distance - halfLength) / feather;
      const intensity = edge <= 0 ? 1 : 1 - smoothstep(edge);
      const next = Math.max(intensity, trail[index] * TRAIL_DECAY);
      residue = Math.max(residue, next - intensity);
      trail[index] = next;
      return next;
    };
    const colorAt = (level: number): string => blend(fill, c.track, 1 - level);
    const lines: string[] = [];
    for (let row = 0; row < state.viewportHeight; row += 1) {
      const topLevel = sample(row + 0.25, row * 2);
      const bottomLevel = sample(row + 0.75, row * 2 + 1);
      if (Math.max(topLevel, bottomLevel) < 0.08) {
        const pattern = c.trackPattern;
        lines.push(pattern && row % 2 === 0
          ? `{${c.trackPatternColor ?? c.track}-fg}${pattern}{/}`
          : ' ');
        continue;
      }
      // Continuous intensity and a soft glyph edge make the capsule feel like
      // a moving object. A row is a full block only when both of its halves
      // are lit; otherwise the brighter half's half-block glyph carries the
      // edge, so a growing/shrinking capsule tapers ▀/▄ → █ and never shows a
      // stray dim block ahead of its cap.
      const topColor = colorAt(topLevel);
      const bottomColor = colorAt(bottomLevel);
      const topLit = topLevel > 0.52;
      const bottomLit = bottomLevel > 0.52;
      if (topLit && bottomLit) {
        lines.push(`{${colorAt(Math.max(topLevel, bottomLevel))}-fg}${PILL_BODY}{/}`);
      } else if (topLevel >= bottomLevel) {
        lines.push(`{${topColor}-fg}${HALF_TOP}{/}`);
      } else {
        lines.push(`{${bottomColor}-fg}${HALF_BOTTOM}{/}`);
      }
    }
    overlay.setContent(lines.join('\n'));
  };

  /** Advance the spring one frame; true when the pill has come to rest. */
  const stepSpring = (target: number): boolean => {
    if (visual === null) {
      visual = target;
      return true;
    }
    velocity = (velocity + (target - visual) * SPRING_STIFFNESS) * SPRING_DAMPING;
    visual += velocity;
    if (Math.abs(target - visual) < SPRING_SETTLE && Math.abs(velocity) < SPRING_SETTLE) {
      visual = target;
      velocity = 0;
      return true;
    }
    return false;
  };

  const frame = (): void => {
    if (visual === null || overlay.hidden) {
      sleep();
      return;
    }
    // Native selection mode releases mouse capture; freezing the spring keeps
    // the idle screen bit-stable while the user selects text.
    const program = element.screen.program as { mouseEnabled?: boolean } | undefined;
    if (program?.mouseEnabled === false) {
      sleep();
      return;
    }
    const lpos = element.lpos as unknown as Lpos | undefined;
    const state = lpos && !element.hidden && !element.detached ? computePillScrollbarState(element, lpos) : null;
    if (!state || !lpos) {
      overlay.hide();
      sleep();
      return;
    }
    overlay.left = lpos.xl - 1;
    overlay.top = lpos.yi + Number(element.itop);
    overlay.height = state.viewportHeight;
    const settled = stepSpring(targetOf(state));
    paint(state, visual);
    // Keep painting until both the spring and the trail have drained, so the
    // pill never comes to rest showing motion-only transparency.
    if (settled && residue < 0.03) stopTimer();
    else element.screen.render();
  };

  const wake = (): void => {
    if (timer === null) timer = setInterval(frame, FRAME_MS);
  };

  const sync = (): void => {
    const lpos = element.lpos as unknown as Lpos | undefined;
    if (element.hidden || element.detached || !lpos) {
      overlay.hide();
      sleep();
      return;
    }
    const state = computePillScrollbarState(element, lpos);
    if (!state) {
      overlay.hide();
      sleep();
      return;
    }
    overlay.show();
    overlay.left = lpos.xl - 1;
    overlay.top = lpos.yi + Number(element.itop);
    overlay.width = 1;
    overlay.height = state.viewportHeight;
    if (visual === null) {
      // First paint after a show snaps to the scroll position; only later
      // scroll deltas glide on the spring.
      visual = targetOf(state);
      velocity = 0;
    }
    paint(state, visual);
    // Only animate when the spring has distance to cover or a trail ghost is
    // still draining; a settled sync (the common case) paints once and leaves
    // the timer dead.
    if (Math.abs(targetOf(state) - visual) > SPRING_SETTLE || residue > 0.03) wake();
  };

  // Hover boost repaints immediately so the affordance does not wait for the
  // next data-driven refresh.
  const repaintHover = (): void => {
    if (lastState === null || visual === null || overlay.hidden) return;
    paint(lastState, visual);
    element.screen.render();
  };

  element.on('scroll', sync);
  element.on('resize', sync);
  element.on('hide', () => {
    overlay.hide();
    sleep();
  });
  element.on('detach', () => {
    overlay.hide();
    sleep();
  });

  // The overlay column stays interactive: wheel scrolls the tracked element,
  // click jumps proportionally to the click position, and drag follows the
  // pointer continuously while retaining the point where the pill was grabbed.
  const pointerState = (): { lpos: Lpos; state: PillState } | null => {
    const lpos = element.lpos as unknown as Lpos | undefined;
    const state = lpos ? computePillScrollbarState(element, lpos) : null;
    return lpos && state ? { lpos, state } : null;
  };
  const setFromPointer = (y: number): void => {
    const current = pointerState();
    if (!current) return;
    const { lpos, state } = current;
    const travel = Math.max(1, state.viewportHeight - state.thumbHeight);
    const top = clamp(y - (lpos.yi + Number(element.itop)) - dragOffset, 0, travel);
    element.scrollTo(Math.round((top / travel) * state.maxOffset));
  };
  overlay.on('wheelup', () => element.scroll(-WHEEL_SCROLL_LINES));
  overlay.on('wheeldown', () => element.scroll(WHEEL_SCROLL_LINES));
  overlay.on('mousedown', (data: { y?: number }) => {
    const current = pointerState();
    if (!current || data.y === undefined) return;
    const { lpos, state } = current;
    const top = visual ?? targetOf(state);
    const localY = data.y - (lpos.yi + Number(element.itop));
    dragOffset = localY >= top && localY <= top + state.thumbHeight ? localY - top : state.thumbHeight / 2;
    dragging = true;
    movedDuringDrag = false;
    setFromPointer(data.y);
  });
  const onScreenMouseMove = (data: { y?: number }): void => {
    if (!dragging || data.y === undefined) return;
    movedDuringDrag = true;
    setFromPointer(data.y);
  };
  const onScreenMouseUp = (): void => {
    dragging = false;
  };
  overlay.onScreenEvent('mousemove', onScreenMouseMove);
  overlay.onScreenEvent('mouseup', onScreenMouseUp);
  overlay.on('mouseover', () => {
    hover = true;
    repaintHover();
  });
  overlay.on('mouseout', () => {
    hover = false;
    repaintHover();
  });
  overlay.on('click', (data: { x?: number; y?: number }) => {
    if (movedDuringDrag) {
      movedDuringDrag = false;
      return;
    }
    const lpos = element.lpos as unknown as Lpos | undefined;
    const state = lpos ? computePillScrollbarState(element, lpos) : null;
    if (!lpos || !state) return;
    const trackY = lpos.yi + Number(element.itop);
    const travel = Math.max(1, state.viewportHeight - state.thumbHeight);
    const ratio = clamp(((data.y ?? trackY) - trackY - state.thumbHeight / 2) / travel, 0, 1);
    element.scrollTo(Math.round(ratio * state.maxOffset));
  });

  return {
    sync,
    destroy: () => {
      stopTimer();
      dragging = false;
      overlay.removeScreenEvent('mousemove', onScreenMouseMove);
      overlay.removeScreenEvent('mouseup', onScreenMouseUp);
      overlay.destroy();
    },
  };
}
