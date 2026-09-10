import { resolve as resolvePath, sep } from 'node:path';
import blessed from 'blessed';

import type { BackendConfig } from '../backend.js';
import type { AgentConfig } from '../config.js';
import { createProviderFlows } from './provider-models.js';
import type { AgentEvent, AgentInstance, AgentSession } from '../domain/agent.js';
import { renderTuiMarkdown, toolDiff } from './markdown.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import { layoutComposer } from './composer-layout.js';
import { renderWelcome } from './welcome.js';
import { copyText } from './clipboard.js';
import { commandMatches } from './commands.js';
import { runShellCommand } from '../infra/tools.js';
import { diffPreview, elapsedLabel, isWaitingForFirstToken, spinnerGlyph, STATUS_PRESENTATION, toolPresentation, tuiLayout, visibleTimelineEntries, waitingIndicatorFrame } from './tui-design.js';
import { attachPillScrollbar, type PillScrollbarHandle, type PillScrollbarTheme, pillScrollbarColors } from './scrollbar.js';
import { recordTimeline, recordShellRun } from '../runtime/session-timeline.js';
import { otherWorkspaceInstances, type WorkspaceInstanceInfo } from '../runtime/workspace-instances.js';
import { activeTuiTheme, resolveTheme, setActiveTheme, themeNames } from './theme.js';
import type { TuiTheme, TuiThemeColors, Tone } from './theme.js';
import { resetTuiMarkdownCache } from './markdown.js';
import { BRACKETED_PASTE_DISABLE, BRACKETED_PASTE_ENABLE, enableBracketedPaste } from './bracketed-paste.js';
import { WorktreeManager, type WorktreeInfo } from '../runtime/worktree.js';
import { installBlessedEmojiWidthSupport } from './blessed-unicode.js';

type ResolvedModel = { name: string; config: BackendConfig };

type ConfigManager = {
  getConfig: () => AgentConfig;
  saveConfig: (config: AgentConfig) => Promise<void>;
};

export interface FullscreenTuiOptions {
  copyToClipboard?: (text: string) => Promise<void>;
  modelName: string;
  modelAliases?: string[];
  resolveModel: (name?: string) => ResolvedModel;
  persistModelSelection?: (name: string) => Promise<void>;
  configManager: ConfigManager;
}

const COLOR = (): TuiThemeColors => activeTuiTheme().ui;

const TONE_COLOR = (tone: Tone): string => COLOR()[tone];

function oneLine(value: string | undefined, max = 72): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safe(value: string): string {
  return blessed.escape(value);
}


export async function runFullscreenTui(runtime: AgentRuntime, options: FullscreenTuiOptions): Promise<void> {
  // Blessed's Unicode table treats modern emoji as one column even though the
  // terminal paints them as two. Fix its shared width table before creating
  // any widgets so incremental redraws do not leave a stale emoji tail cell.
  installBlessedEmojiWidthSupport((blessed as unknown as { unicode: { charWidth: (value: string | number, index?: number) => number; codePointAt: (value: string, index?: number) => number } }).unicode);
  let sessionId = `session-${Date.now()}`;
  let session = await runtime.openSession(sessionId);
  const instanceCache = new Map(runtime.listInstances(sessionId).map((instance) => [instance.instanceId, instance]));
  let activeModel = options.modelName;
  let activityVisible = false;
  let composerPinned = true;
  let selectedActivityIndex = 0;
  let closed = false;
  let composerCursor = 0;
  let historyIndex: number | undefined;
  let historyDraft = '';
  let spinnerFrame = 0;
  let spinnerTimer: NodeJS.Timeout | undefined;
  let welcomeTimer: NodeJS.Timeout | undefined;
  let welcomeFrame = 0;
  let welcomeStartedAt = 0;
  // Set between a committed theme change and the next renderConversation():
  // the welcome clock is then rebased so the mark replays its one-second
  // opening act under the new palette. Preview highlights and Esc/✕ rollbacks
  // restore the previous palette without a change and never set this.
  let themeIntroReplay = false;
  // Terminal focus lifecycle (DECSET 1004). While the window is unfocused the
  // app must be frugal with PTY writes: a refocusing terminal replays the
  // bytes it did not render, and a backlog of pending updates is what users
  // see as the "crazy scrolling" burst on focus regain. Two rules:
  //  - Decorative animation (spinner glyphs, welcome shine, shell ellipsis) is
  //    suppressed outright while blurred: it is invisible in an unfocused
  //    window, and every frame is a multi-row byte burst.
  //  - Streaming text keeps flowing on a ~400ms heartbeat so a background
  //    window still shows the transcript growing. Event-driven repaints (tool
  //    calls, finished messages) are never throttled.
  // Frames skipped for blur set `blurredStale`; focus regain then issues
  // exactly one full redraw (like a resize) instead of replaying a backlog.
  let windowFocused = true;
  let blurredStale = false;
  const BLURRED_STREAM_MS = 400;
  let lastStreamFrame = 0;
  // Heartbeat gate for the stream repaint timer: true at most once every
  // BLURRED_STREAM_MS while unfocused, always while focused.
  const throttledFrame = (): boolean => {
    if (windowFocused) return true;
    const now = Date.now();
    if (now - lastStreamFrame < BLURRED_STREAM_MS) return false;
    lastStreamFrame = now;
    blurredStale = true;
    return true;
  };
  let streamTimer: NodeJS.Timeout | undefined;
  let shellAbort: AbortController | undefined;
  let shellAnimationFrame = 0;
  let waitingFrame = 0;
  let lastPaintedStreamText = '';
  const composerChars: string[] = [];
  const inputHistory: string[] = [];
  const pendingTurns = new Set<string>();
  const streams = new Map<string, string>();
  const activityLog = new Map<string, string[]>();
  interface ThinkingBlock {
    turnId: string;
    thinking?: string;
    expanded: boolean;
    content: string[];
    status: 'active' | 'completed';
    startedAt?: number;
    finishedAt?: number;
  }
  const thinkingBlocks = new Map<string, ThinkingBlock>();
  const thinkingBlockLines = new Map<string, { headerLine: number; lastLine: number }>();
  // Rendered header row per collapsible entry, captured while the transcript
  // is built. The pinned overlay reuses it verbatim so a Read/Run row keeps
  // its status icon and detail instead of a generic label.
  const stickyHeaderLines = new Map<string, string>();
  // Sticky collapse header: when an expanded block's own header has scrolled
  // above the viewport while the block body is still on screen, the header is
  // redrawn pinned to the first conversation row so it can always be clicked
  // to collapse. Sticky rows do not exist in the logical content; they are
  // inserted at the viewport top after scrolling is applied.
  // Streaming events can batch: a thinking segment may be rendered only after
  // it already finished, so the start time is tracked per turn, not per block.
  const thinkingStartedAt = new Map<string, number>();
  const markThinkingStart = (turnId: string): void => {
    if (!thinkingStartedAt.has(turnId)) thinkingStartedAt.set(turnId, Date.now());
  };
  let latestThinkingTurnId: string | undefined;
  // `lastLine` is the block's final rendered line; the pinned header must
  // disappear once the whole block (not just its header) leaves the top.
  type StickyHeader = { turnId: string; line: string; lastLine: number; redrawKey: string };
  let stickyHeader: StickyHeader | undefined;
  let lastStickyKey: string | undefined;
  // Blessed bubbles a click from the sticky overlay up to the conversation
  // box; the flag consumes the bubbled copy so the block is toggled once.
  let stickyClickHandled = false;
  let conversationFollowOutput = true;
  let conversationScrollOffset = 0;
  let restoringConversationScroll = false;
  let conversationDirty = true;
  let activityDirty = true;
  let lastLayoutKey = '';
  let composerRow = 0;
  let composerColumn = 0;
  let notice = '';
  // Live model-request count for the main instance's running turn. Informational
  // only: the runtime has no step budget, so this never implies a hard limit.
  let activeTurnStep: number | undefined;
  let completionIndex = 0;
  let completionQuery = '';
  let dismissedCompletion = '';
  let nativeSelection = false;
  // /btw side conversation state. Inside a side session, `sideParentSessionId`
  // points at the conversation /back and Ctrl+C return to. /fork works from
  // anywhere but never changes the mode.
  let sideParentSessionId: string | undefined;
  const isBtw = (): boolean => sideParentSessionId !== undefined;
  type Point = { x: number; y: number };
  let selection: { start: Point; end: Point; rows: string[][]; left: number; right: number; top: number; bottom: number; dragging: boolean } | undefined;
  const hasSelection = (): boolean => Boolean(selection && (selection.start.x !== selection.end.x || selection.start.y !== selection.end.y));

  // When the sticky row's identity or text changes, a full redraw avoids
  // blessed CSR diff artifacts around the shifted top row.
  const invalidateStickyIfChanged = (next?: StickyHeader): void => {
    const key = next ? `${next.turnId} :: ${next.line}` : '';
    if (key !== lastStickyKey) {
      lastStickyKey = key || undefined;
      requestFullRedraw();
    }
  };

  const restoreThinking = (): void => {
    const restored = new Map<string, string>();
    for (const message of session.messages) {
      if (message.thinking && message.turnId) restored.set(message.turnId, `${restored.get(message.turnId) ?? ''}${message.thinking}`);
    }
    for (const [turnId, thinking] of restored) {
      if (!thinkingBlocks.has(turnId)) thinkingBlocks.set(turnId, { turnId, expanded: false, content: [], status: 'completed', thinking });
    }
  };
  restoreThinking();
  setActiveTheme(options.configManager.getConfig().theme);

  // Bracketed paste: the terminal wraps pasted text in `\x1b[200~ ... \x1b[201~`.
  // The filter turns each wrapped chunk into one paste event, so line breaks
  // inside a paste insert literally instead of being read as Enter (which
  // used to submit the half-pasted draft).
  const pasteInput = enableBracketedPaste(process.stdin);
  const screen = blessed.screen({
    input: pasteInput,
    smartCSR: true, fullUnicode: true, forceUnicode: true, title: 'TokenMaw',
    style: { bg: COLOR().background, fg: COLOR().text },
  });
  screen.program.write(BRACKETED_PASTE_ENABLE);
  // Blessed defers alt-buffer entry to terminfo's smcup, which is empty on
  // several TERM entries — the app then paints into the scrollback and every
  // animated repaint shoves the native scrollbar around. Force ?1049 so the
  // TUI owns the alternate screen (restored on exit) regardless of terminfo.
  screen.program.decset('1049');
  screen.program.decset('1004');
  let fullRedrawPending = true;
  const requestFullRedraw = (): void => { fullRedrawPending = true; };
  // Frame atomicity. Blessed already double-buffers — every frame is a diff
  // against its previous buffer (lines/olines) — but it streams that diff to
  // the terminal as it computes it. A frame whose cells are scattered across
  // the screen (the matrix theme's rain wets rows top to bottom every frame)
  // is then painted while arriving: the terminal shows half-frames, the
  // cursor jumps across the screen, and the animation reads as flicker.
  // DEC 2026 synchronized output brackets the frame so a supporting terminal
  // buffers the whole update and swaps it in once — the terminal-side half
  // of a double-buffer swap. Terminals without support ignore unknown DEC
  // modes and behave exactly as before, so this is safe to always send.
  const SYNC_BEGIN = '\x1b[?2026h';
  const SYNC_END = '\x1b[?2026l';
  // _write is blessed's buffered writer (Program.prototype._write); the public
  // typings omit it, so reach it through a structural cast.
  const bufferedWrite = (text: string): void => {
    (screen.program as unknown as { _write(text: string): void })._write(text);
  };
  const renderScreen = (afterRender?: () => void): void => {
    // Order matters. program.write() (_owrite) writes straight to the pty,
    // while the frame body goes through _write -> _buffer -> nextTick flush.
    // Bracketing with write() would emit END before the frame even starts.
    // _write appends to the same blessed buffer the frame is flushed into:
    // draw() absorbs any pending _buf at its top, so BEGIN is re-buffered
    // ahead of the frame, END follows it, and one nextTick writes the whole
    // frame out in order.
    bufferedWrite(SYNC_BEGIN);
    if (fullRedrawPending) {
      // Blessed's smart CSR occasionally leaves the tail of a wide/long line
      // behind when an element shrinks or disappears. Reallocating only for
      // structural transitions clears both its current and previous buffers.
      // This must run inside the bracket: realloc() calls program.clear(),
      // whose \x1b[2J would otherwise escape the frame and visibly blank
      // the screen before the atomic swap.
      screen.realloc();
      fullRedrawPending = false;
    }
    screen.render();
    // Cursor position is part of an atomic frame under DEC 2026: terminals
    // swap the cursor along with the cells. Any cursor write emitted after
    // the closing bracket lands outside the synchronized update and jumps
    // mid-paint, so callers place the caret through this callback instead.
    afterRender?.();
    bufferedWrite(SYNC_END);
  };
  const screenBuffer = screen as unknown as { lines: Array<Array<[number, string]> & { dirty: boolean }> };

  const statusbar = blessed.box({
    parent: screen, bottom: 0, left: 0, width: '100%', height: 1, tags: true,
    padding: { left: 1, right: 1 }, style: { bg: COLOR().background, fg: COLOR().muted },
  });
  const conversation = blessed.box({
    parent: screen, top: 0, left: 0, width: '100%', bottom: 3,
    tags: true, scrollable: true, alwaysScroll: true, keys: true, vi: true, mouse: true, autoFocus: false,
    padding: { left: 2, right: 2 },
    style: { bg: COLOR().background, fg: COLOR().text },
  });
  // Full-width surface keeps the composer visually continuous at both edges;
  // the editable text box is inset on top of this backdrop.
  const composerBackdrop = blessed.box({
    parent: screen, bottom: 1, left: 0, width: '100%', height: 2,
    style: { bg: COLOR().composer },
  });
  const activity = blessed.list({
    parent: screen, top: 3, right: 0, width: '28%', bottom: 2,
    tags: true, keys: true, vi: true, mouse: true,
    scrollable: true, padding: { left: 1, right: 1 },
    style: {
      bg: COLOR().activity, fg: COLOR().muted,
      selected: { bg: COLOR().elevated, fg: COLOR().accent, bold: true },
    },
  });
  const composer = blessed.box({
    parent: screen, bottom: 1, left: 3, width: '100%-4', height: 2,
    input: true, keys: true, mouse: true, autoFocus: false, padding: { left: 0, right: 1 },
    tags: true,
    style: { bg: COLOR().composer, fg: COLOR().text },
  });
  const divider = blessed.box({
    // This row is part of the composer surface. Keeping it full width makes
    // the input area read as one continuous band instead of a boxed field
    // separated by a decorative rule.
    parent: screen, bottom: 3, left: 0, width: '100%', height: 1,
    style: { fg: COLOR().composer, bg: COLOR().composer },
  });
  const composerPrompt = blessed.box({
    parent: screen, bottom: 1, left: 1, width: 2, height: 2,
    content: '›', style: { bg: COLOR().composer, fg: COLOR().accent },
  });
  const completions = blessed.list({
    parent: screen, left: 2, bottom: 4, width: '100%-4', height: 5,
    hidden: true, tags: true, mouse: true, keys: false, autoFocus: false,
    padding: { left: 1, right: 1 },
    style: { bg: COLOR().panel, fg: COLOR().muted, selected: { bg: COLOR().elevated, fg: COLOR().accent, bold: true } },
  });
  const activityHeader = blessed.box({
    parent: screen, top: 0, right: 0, width: '28%', height: 3, hidden: true, tags: true,
    padding: { left: 1, right: 1 }, style: { bg: COLOR().activity, fg: COLOR().text },
  });
  const activityDetailScrollbar: { current?: PillScrollbarHandle } = {};
  let activityDetail: { instanceId: string; modal: blessed.Widgets.BoxElement; body: blessed.Widgets.BoxElement } | undefined;

  // Pill scrollbars are screen-level overlay elements; they resolve theme
  // colors on every sync, so a theme switch needs no extra patching.
  const pillColors = (): PillScrollbarTheme => pillScrollbarColors(COLOR());
  const conversationScrollbar = attachPillScrollbar(conversation, pillColors);
  const activityScrollbar = attachPillScrollbar(activity, pillColors);

  // Persistent widgets capture style objects at creation time; a theme switch
  // must patch them in place so the repaint picks up the new palette.
  const applyWidgetTheme = (): void => {
    const c = COLOR();
    statusbar.style.bg = c.background;
    statusbar.style.fg = c.muted;
    conversation.style.bg = c.background;
    conversation.style.fg = c.text;
    activity.style.bg = c.activity;
    activity.style.fg = c.muted;
    // blessed's List copies style.item from the constructor palette and reads
    // it per unselected row on every render, so it must be re-created here.
    activity.style.item = { bg: c.activity, fg: c.muted };
    activity.style.selected = { bg: c.elevated, fg: c.accent, bold: true };
    composer.style.bg = c.composer;
    composer.style.fg = c.text;
    composerBackdrop.style.bg = c.composer;
    divider.style.fg = c.composer;
    divider.style.bg = c.composer;
    composerPrompt.style.bg = c.composer;
    composerPrompt.style.fg = c.accent;
    completions.style.bg = c.panel;
    completions.style.fg = c.muted;
    completions.style.item = { bg: c.panel, fg: c.muted };
    completions.style.selected = { bg: c.elevated, fg: c.accent, bold: true };
    activityHeader.style.bg = c.activity;
    activityHeader.style.fg = c.text;
  };
  applyWidgetTheme();

  screen.program.setMouse({ vt200Mouse: true, sgrMouse: true, utfMouse: false, cellMotion: true, allMotion: true }, true);

  const placeComposerCursor = (): void => {
    if (closed || screen.focused !== composer) return;
    const lpos = composer.lpos;
    if (!lpos) return;
    screen.program.cursorPos(lpos.yi + Number(composer.itop) + composerRow, lpos.xi + Number(composer.ileft) + composerColumn);
  };

  const composerValue = (): string => composerChars.join('');

  const setComposerValue = (value: string): void => {
    composerChars.splice(0, composerChars.length, ...Array.from(value));
    composerCursor = composerChars.length;
    historyIndex = undefined;
    historyDraft = '';
  };

  const renderComposer = (): void => {
    const width = Math.max(2, Number(screen.width) - 5);
    const result = layoutComposer(composerValue(), composerCursor, width, (text) => Number(composer.strWidth(text)));
    const height = Math.min(Math.max(2, result.rows.length), Math.max(2, Math.min(6, Number(screen.height) - 7)));
    const start = Math.max(0, result.cursor.row - height + 1);
    // A draft starting with `!` is shell mode: the prompt becomes `$` and the
    // command text wears the shell color so the submit target is unambiguous.
    const shellMode = composerValue().startsWith('!');
    composerPrompt.setContent(shellMode ? '$' : '›');
    composerPrompt.style.fg = shellMode ? COLOR().warning : COLOR().accent;
    composer.height = height;
    composerPrompt.height = height;
    composerBackdrop.height = height;
    conversation.bottom = height + 2;
    activity.bottom = height + 2;
    divider.bottom = height + 1;
    divider.setContent(' '.repeat(Math.max(0, Number(screen.width))));
    composerRow = result.cursor.row - start;
    composerColumn = result.cursor.column;
    // Rows are laid out from plain text; escape them for the tag parser so
    // commands containing literal braces render as typed.
    const visibleRows = result.rows.slice(start, start + height).map((row) => safe(row));
    composer.setContent(shellMode
      ? visibleRows.map((row) => `{${COLOR().warning}-fg}${row}{/${COLOR().warning}-fg}`).join('\n')
      : visibleRows.join('\n'));
    const query = composerValue();
    if (query !== completionQuery) { completionIndex = 0; completionQuery = query; }
    const matches = query === dismissedCompletion ? [] : commandMatches(query);
    const completionsWereHidden = completions.hidden;
    if (!matches.length) completions.hide();
    else {
      completions.bottom = height + 2;
      completions.height = Math.min(matches.length, 6, Math.max(1, Number(screen.height) - height - 3));
      completionIndex = Math.min(completionIndex, matches.length - 1);
      completions.setItems(matches.map((item) => `{${COLOR().accent}-fg}${safe(item.name.padEnd(12))}{/${COLOR().accent}-fg} {${COLOR().muted}-fg}${safe(item.description)}{/${COLOR().muted}-fg}`));
      completions.select(completionIndex);
      completions.show();
      completions.setFront();
    }
    if (completionsWereHidden !== completions.hidden) requestFullRedraw();
  };

  // The caret position and cursor visibility ride inside the bracketed frame
  // (see renderScreen): a post-render cursor write lands outside the atomic
  // update and makes the caret jump while the frame paints.
  const syncComposerCursor = (): void => {
    placeComposerCursor();
    screen.program.showCursor();
  };

  const renderComposerFrame = (): void => {
    renderComposer();
    screen.program.hideCursor();
    renderScreen(syncComposerCursor);
  };

  const updateHistory = (direction: -1 | 1): void => {
    if (inputHistory.length === 0) return;
    if (historyIndex === undefined) {
      if (direction > 0) return;
      historyDraft = composerValue();
      historyIndex = inputHistory.length - 1;
    } else {
      const next = historyIndex + direction;
      if (next < 0) return;
      if (next >= inputHistory.length) {
        historyIndex = undefined;
        setComposerValue(historyDraft);
        renderComposer();
        renderComposerFrame();
        return;
      }
      historyIndex = next;
    }
    const value = inputHistory[historyIndex] ?? '';
    composerChars.splice(0, composerChars.length, ...Array.from(value));
    composerCursor = composerChars.length;
    renderComposer();
    renderComposerFrame();
  };

  const insertPaste = (text: string): void => {
    const chars = Array.from(text);
    composerChars.splice(composerCursor, 0, ...chars);
    composerCursor += chars.length;
  };

  const handleComposerKey = (ch: string, key: { name?: string; ctrl?: boolean; meta?: boolean }): void => {
    if (closed) return;
    if (pasteInput.pasteActive) {
      // Paste content is literal: line breaks included, never a submit.
      // CR is normalized to LF so browser-style CRLF pastes stay clean.
      if (ch === '\r' || ch === '\n') insertPaste('\n');
      else if (ch && !key.ctrl && !key.meta && !/^[\x00-\x1f\x7f]$/.test(ch)) insertPaste(ch);
      // Long pastes span many reads: keep repainting so the composer does
      // not appear frozen while the paste streams in.
      scheduleRefresh();
      return;
    }
    const matches = completions.hidden ? [] : commandMatches(composerValue());
    if (matches.length && (key.name === 'up' || key.name === 'down')) {
      completionIndex = (completionIndex + (key.name === 'up' ? -1 : 1) + matches.length) % matches.length;
      renderComposerFrame(); return;
    }
    if (matches.length && key.name === 'escape') {
      dismissedCompletion = composerValue(); renderComposerFrame(); return;
    }
    // A bare Escape stops the running turn, same as Ctrl+X / `/cancel`. The
    // completion menu and the screen-level bindings keep their Esc semantics
    // (dismiss suggestions, leave a focused pane), so stop only when nothing
    // else claims the key and something is actually running — a stray press
    // while idle stays a no-op instead of wiping queued work.
    if (key.name === 'escape') {
      const active = instances().some((item) => ['running', 'waiting', 'queued'].includes(item.status));
      if (active) void command('/cancel').catch((error) => { notice = String(error); refresh(); });
      return;
    }
    if (matches.length && (key.name === 'tab' || ((!key.meta) && (key.name === 'enter' || key.name === 'return')))) {
      setComposerValue(matches[completionIndex]!.name + (key.name === 'tab' ? ' ' : ''));
      if (key.name === 'tab') renderComposerFrame(); else void submit();
      return;
    }
    if ((key.name === 'enter' || key.name === 'return') && !key.meta) { void submit(); return; } // guarded above: never fires inside a paste
    if ((key.meta && (key.name === 'enter' || key.name === 'return')) || (key.ctrl && key.name === 'j')) {
      composerChars.splice(composerCursor++, 0, '\n');
    }
    else if (key.name === 'left') composerCursor = Math.max(0, composerCursor - 1);
    else if (key.name === 'right') composerCursor = Math.min(composerChars.length, composerCursor + 1);
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) composerCursor = 0;
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) composerCursor = composerChars.length;
    else if (key.name === 'up') { updateHistory(-1); return; }
    else if (key.name === 'down') { updateHistory(1); return; }
    else if (key.name === 'backspace') {
      if (composerCursor > 0) composerChars.splice(composerCursor - 1, 1);
      composerCursor = Math.max(0, composerCursor - 1);
    } else if (key.name === 'delete') {
      composerChars.splice(composerCursor, 1);
    } else if (key.ctrl && key.name === 'u') {
      composerChars.splice(0, composerChars.length);
      composerCursor = 0;
    } else if (ch && !key.ctrl && !key.meta && !/^[\x00-\x1f\x7f]$/.test(ch)) {
      composerChars.splice(composerCursor, 0, ...Array.from(ch));
      composerCursor += Array.from(ch).length;
    } else {
      return;
    }
    historyIndex = undefined;
    historyDraft = '';
    renderComposer();
    renderComposerFrame();
  };

  // The thinking header spins on a fixed 60ms cadence; spinnerGlyphFrame maps
  // each tick onto an eased burst-and-pause rhythm (fast, then slow) so the
  // animation feels alive instead of metronome-slow.
  const startSpinner = (): void => {
    if (spinnerTimer || pendingTurns.size === 0) return;
    spinnerTimer = setInterval(() => {
      if (pendingTurns.size === 0 || closed) {
        stopSpinner();
        return;
      }
      // Decoration only: frozen while blurred. Skipping a frame leaves the
      // screen untouched and still valid, so it must not mark the frame stale
      // — a quiet refocus after decoration-only blur is the whole point.
      if (!windowFocused) return;
      if (nativeSelection || hasSelection()) return;
      spinnerFrame += 1;
      conversationDirty = true;
      scheduleRefresh();
    }, 60);
    spinnerTimer.unref?.();
  };

  const stopSpinner = (): void => {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  };

  // While a turn is live, deltas alone cannot be trusted to defeat blessed's
  // row-diff suppression or the viewport-clamped trailing line, so a slow
  // repaint cadence forces the growing transcript onto the screen. The same
  // tick animates the waiting indicator shown before the first token arrives.
  const stopStreamTimer = (): void => {
    if (!streamTimer) return;
    clearInterval(streamTimer);
    streamTimer = undefined;
  };
  const startStreamTimer = (): void => {
    if (streamTimer || closed) return;
    streamTimer = setInterval(() => {
      if (closed || pendingTurns.size === 0) {
        stopStreamTimer();
        return;
      }
      // Native text selection owns the screen; never dirty or repaint under it.
      if (nativeSelection || hasSelection()) return;
      // Content heartbeat: while blurred, repaint live text at most once per
      // BLURRED_STREAM_MS so the background window keeps up without flooding.
      if (!throttledFrame()) return;
      const runningEntry = [...(session.timeline ?? [])].find((entry) => entry.status === 'running' && entry.kind !== 'tool' && entry.kind !== 'shell');
      if (streams.size > 0 || runningEntry) {
        const liveText = [...streams.values()].join('')
          + [...(session.timeline ?? [])].filter((entry) => entry.status === 'running' && entry.kind === 'message').map((entry) => entry.content).join('');
        if (liveText !== lastPaintedStreamText) {
          // Only a real content change earns a structural repaint; plain diffs
          // stay cheap and flicker-free.
          fullRedrawPending = true;
          lastPaintedStreamText = liveText;
          conversationDirty = true;
        }
      } else {
        // The waiting ellipsis is decoration: frozen while blurred. A skipped
        // frame leaves the screen untouched, so it must not mark it stale.
        if (!windowFocused) return;
        waitingFrame = (waitingFrame + 1) % 24;
        conversationDirty = true;
      }
      scheduleRefresh();
    }, 90);
    streamTimer.unref?.();
  };

  // Depth of open modal dialogs. While any dialog is up, mouse clicks must
  // neither steal focus from the dialog nor let the app's click handlers run:
  // a single stray press (for example after copying a key from another
  // window) used to blur the dialog's textbox, which fires `cancel` inside
  // readInput and silently aborts the whole wizard.
  let modalDepth = 0;

  const focusComposer = (): void => {
    if (closed || modalDepth > 0) return;
    composerPinned = true;
    if (screen.focused !== composer) composer.focus();
    renderComposerFrame();
  };

  /** Hands keyboard focus back to the composer once the last dialog closed. */
  const restoreModalFocus = (): void => {
    modalDepth = Math.max(0, modalDepth - 1);
    if (modalDepth === 0) {
      composerPinned = true;
      focusComposer();
    }
  };

  /** Absorbs clicks landing on a modal's own surface (title, rule, hint
   * rows). Without it, such clicks fall through to the conversation below and
   * its click handler stole focus, which blurs the dialog's textbox —
   * readInput treats that blur as a cancel and silently aborts the wizard. */
  const showModalSurfaceGuard = (): void => {};

  type ChoiceItem = string | { label: string; detail?: string };
  interface ChooseOptions {
    /** Invoked whenever the highlighted entry changes; enables live preview. */
    onHighlight?: (index: number) => void;
    /** Type-to-filter row: printable keys narrow the list live; the resolved
     * index always refers to the original `items` order. */
    searchable?: boolean;
    /** Item index preselected when the modal opens (e.g. the current value). */
    initial?: number;
  }
  /** A small clickable ✕ pinned to a modal's top-right corner. Modals already
   * close on Escape; this gives mouse users the same affordance. */
  const attachCloseButton = (modal: blessed.Widgets.BoxElement, onClose: () => void): blessed.Widgets.BoxElement => {
    const button = blessed.box({
      parent: modal, top: 0, right: 0, width: 3, height: 1, tags: true, mouse: true,
      content: ' {bold}✕{/bold} ',
      style: { bg: COLOR().modal, fg: COLOR().muted, hover: { bg: COLOR().modal, fg: COLOR().error } },
    });
    button.on('click', onClose);
    return button;
  };

  const choose = (title: string, items: ChoiceItem[], options: ChooseOptions = {}): Promise<number> => new Promise((resolveChoice) => {
    composerPinned = false;
    modalDepth++;
    const searchable = options.searchable === true;
    const renderItem = (item: ChoiceItem): string => typeof item === 'string'
      ? safe(item)
      : `{bold}${safe(item.label)}{/bold}${item.detail ? `  {${COLOR().muted}-fg}${safe(item.detail)}{/${COLOR().muted}-fg}` : ''}`;
    const itemWidths = items.map((item) => typeof item === 'string' ? item.length : Math.max(item.label.length, item.detail?.length ?? 0));
    const width = Math.min(Math.max(28, Number(screen.width) - 4), 82, Math.max(36, ...itemWidths.map((item) => item + 8)));
    const height = Math.min(items.length + (searchable ? 5 : 4), 22, Math.max(searchable ? 7 : 6, Number(screen.height) - 2));
    const modal = blessed.box({
      parent: screen, top: 'center', left: 'center', width, height,
      tags: true, clickable: true, autoFocus: false, style: { bg: COLOR().modal, fg: COLOR().text },
    });
    modal.on('click', showModalSurfaceGuard);
    const heading = blessed.box({
      parent: modal, top: 0, left: 1, right: 1, height: 1, tags: true,
      content: `{bold}${safe(title)}{/bold}`, style: { bg: COLOR().modal, fg: COLOR().text },
    });
    const filterRow = searchable
      ? blessed.box({
          parent: modal, top: 1, left: 1, right: 1, height: 1, tags: true,
          style: { bg: COLOR().modal, fg: COLOR().subtle },
        })
      : undefined;
    const rule = blessed.box({
      parent: modal, top: searchable ? 2 : 1, left: 1, right: 1, height: 1, tags: true,
      content: `{${COLOR().modalRule}-fg}${'─'.repeat(Math.max(0, width - 2))}{/${COLOR().modalRule}-fg}`,
      style: { bg: COLOR().modal, fg: COLOR().modalRule },
    });
    const list = blessed.list({
      parent: modal, top: searchable ? 3 : 2, left: 1, right: 1, bottom: 1,
      items: items.map(renderItem), tags: true, keys: true, vi: !searchable, mouse: true,
      scrollable: true, style: { bg: COLOR().modal, fg: COLOR().text, selected: { bg: COLOR().modal, fg: COLOR().accent, bold: true } },
    });
    // Type-to-filter state: `currentMap` maps displayed rows back to the
    // original items order so selection and highlight stay stable under
    // filtering.
    let filterText = '';
    let currentMap: number[] = items.map((_, index) => index);
    const renderFilterRow = (): void => {
      if (!filterRow) return;
      const c = COLOR();
      filterRow.setContent(filterText
        ? `{${c.accent}-fg}/ ${safe(filterText)}{/${c.accent}-fg}{${c.subtle}-fg}▌{/${c.subtle}-fg}`
        : `{${c.subtle}-fg}type to filter…{/${c.subtle}-fg}`);
    };
    const applyFilter = (): void => {
      const query = filterText.trim().toLowerCase();
      currentMap = query
        ? items.map((_, index) => index).filter((index) => {
            const item = items[index]!;
            const haystack = typeof item === 'string' ? item : `${item.label} ${item.detail ?? ''}`;
            return haystack.toLowerCase().includes(query);
          })
        : items.map((_, index) => index);
      if (currentMap.length) {
        list.setItems(currentMap.map((index) => renderItem(items[index]!)));
        list.select(0);
      } else {
        list.setItems([`{${COLOR().subtle}-fg}  no matches{/${COLOR().subtle}-fg}`]);
      }
      renderFilterRow();
      renderScreen();
    };
    if (searchable && filterRow) {
      list.on('keypress', (ch: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
        if (done || key?.ctrl || key?.meta) return;
        if (key?.name === 'backspace') {
          if (!filterText) return;
          filterText = filterText.slice(0, -1);
          applyFilter();
          return;
        }
        const printable = typeof ch === 'string' && ch.length === 1 && ch >= ' ' && ch !== '\x7f';
        if (!printable) return;
        filterText += ch;
        applyFilter();
      });
    }
    const closeButton = attachCloseButton(modal, () => finish(-1));
    // The modal captures style objects at creation time; while a live preview
    // swaps the active palette, re-patch it so it does not keep the palette
    // it was opened with.
    const restyleModal = (): void => {
      const c = COLOR();
      modal.style.bg = c.modal;
      modal.style.fg = c.text;
      heading.style.bg = c.modal;
      heading.style.fg = c.text;
      rule.style.bg = c.modal;
      rule.style.fg = c.modalRule;
      rule.setContent(`{${c.modalRule}-fg}${'─'.repeat(Math.max(0, width - 2))}{/${c.modalRule}-fg}`);
      if (filterRow) {
        filterRow.style.bg = c.modal;
        renderFilterRow();
      }
      list.style.bg = c.modal;
      list.style.fg = c.text;
      // Row elements resolve their palette from list.style.item on render;
      // re-create it or the picker keeps the palette it opened with.
      list.style.item = { bg: c.modal, fg: c.text };
      list.style.selected = { bg: c.modal, fg: c.accent, bold: true };
      closeButton.style.bg = c.modal;
      closeButton.style.fg = c.muted;
      closeButton.style.hover = { bg: c.modal, fg: c.error };
      // Respect the active filter instead of resetting to the full list.
      if (currentMap.length) list.setItems(currentMap.map((index) => renderItem(items[index]!)));
      else list.setItems([`{${c.subtle}-fg}  no matches{/${c.subtle}-fg}`]);
    };
    let done = false;
    const finish = (value: number): void => {
      if (done) return;
      done = true;
      modal.destroy();
      requestFullRedraw();
      restoreModalFocus();
      resolveChoice(value);
    };
    list.on('select', (_item, index) => {
      const mapped = typeof index === 'number' ? currentMap[index] : undefined;
      if (typeof mapped === 'number') finish(mapped);
    });
    // setItems() re-emits 'select item' while restoring the selection, so the
    // preview handler must be re-entrancy guarded or it recurses forever.
    let restyling = false;
    list.on('select item', (_item, index) => {
      if (done || restyling || !options.onHighlight || typeof index !== 'number' || index < 0) return;
      const mapped = currentMap[index];
      if (typeof mapped !== 'number') return;
      restyling = true;
      try {
        options.onHighlight(mapped);
        restyleModal();
        renderScreen();
      } finally {
        restyling = false;
      }
    });
    if (searchable) {
      // `q` types into the filter here, so Escape (and ✕) are the only
      // dismissal shortcuts.
      list.key(['escape'], () => finish(-1));
    } else {
      list.key(['escape', 'q'], () => finish(-1));
    }
    list.focus();
    if (typeof options.initial === 'number' && options.initial > 0) list.select(options.initial);
    renderFilterRow();
    void heading;
    void rule;
    renderScreen();
  });

  const ask = (label: string, initial = '', secret = false): Promise<string> => new Promise((resolveAnswer) => {
    composerPinned = false;
    modalDepth++;
    const width = Math.min(76, Math.max(28, Number(screen.width) - 4));
    const modal = blessed.box({
      parent: screen, top: 'center', left: 'center', width, height: 7,
      tags: true, clickable: true, autoFocus: false, style: { bg: COLOR().modal, fg: COLOR().text },
    });
    modal.on('click', showModalSurfaceGuard);
    blessed.box({
      parent: modal, top: 0, left: 1, right: 1, height: 1, tags: true,
      content: `{bold}${safe(label)}{/bold}`, style: { bg: COLOR().modal, fg: COLOR().text },
    });
    blessed.box({
      parent: modal, top: 1, left: 1, right: 1, height: 1,
      content: '─'.repeat(Math.max(0, width - 2)), style: { bg: COLOR().modal, fg: COLOR().modalRule },
    });
    const input = blessed.textbox({
      parent: modal, top: 3, left: 1, right: 1, height: 1,
      inputOnFocus: true, keys: true, mouse: true, censor: secret,
      style: { bg: COLOR().modal, fg: COLOR().text, focus: { bg: COLOR().modal, fg: COLOR().text } },
    });
    blessed.box({
      parent: modal, bottom: 0, left: 1, right: 1, height: 1,
      content: 'Enter confirm  ·  Esc cancel', style: { bg: COLOR().modal, fg: COLOR().modalRule },
    });
    attachCloseButton(modal, () => finish(''));
    // Title/rule/hint rows have no handlers of their own: a click on them
    // falls through to the conversation unless the modal surface absorbs it.
    input.setValue(initial);
    let done = false;
    const finish = (value: string): void => {
      if (done) return;
      done = true;
      modal.destroy();
      requestFullRedraw();
      restoreModalFocus();
      resolveAnswer(value.trim());
    };
    input.on('submit', (value) => finish(String(value ?? '')));
    input.on('cancel', () => finish(''));
    input.key('escape', () => finish(''));
    input.focus();
    input.readInput();
    renderScreen();
  });

  const instances = (): AgentInstance[] => [...instanceCache.values()];

  // Cross-process awareness: periodically look for other live maw instances
  // in the same workspace so the status bar can warn before edits collide.
  let otherInstances: WorkspaceInstanceInfo[] = [];
  const instancePoll = setInterval(() => {
    void otherWorkspaceInstances(runtime.workspace()).then((found) => {
      const changed = found.length !== otherInstances.length
        || found.some((item, index) => item.pid !== otherInstances[index]?.pid);
      otherInstances = found;
      if (changed) { renderStatus(); renderScreen(); }
    }).catch(() => undefined);
  }, 15_000);
  instancePoll.unref?.();
  void otherWorkspaceInstances(runtime.workspace()).then((found) => {
    otherInstances = found;
    renderStatus();
  }).catch(() => undefined);

  const depthPrefix = (instance: AgentInstance): string => {
    const status = STATUS_PRESENTATION[instance.status];
    const color = TONE_COLOR(status.tone);
    return `${'  '.repeat(instance.depth)}{${color}-fg}${status.icon}{/${color}-fg}`;
  };

  const renderStatus = (): void => {
    const active = instances().filter((item) => item.status === 'running' || item.status === 'waiting' || item.status === 'queued').length;
    const activityText = active ? `${active} active${activeTurnStep !== undefined ? ` · step ${activeTurnStep}` : ''}` : 'Ready';
    const usage = instances().reduce((total, item) => {
      total.input += item.usage?.inputTokens ?? 0;
      total.output += item.usage?.outputTokens ?? 0;
      total.cached += item.usage?.cachedInputTokens ?? 0;
      if (item.usage?.firstTokenMs !== undefined) total.firstTokenMs = total.firstTokenMs === undefined ? item.usage.firstTokenMs : Math.min(total.firstTokenMs, item.usage.firstTokenMs);
      return total;
    }, { input: 0, output: 0, cached: 0, firstTokenMs: undefined as number | undefined });
    const usageText = usage.input || usage.output ? `  ·  ${usage.input + usage.output} tok${usage.cached ? ` (${usage.cached} cached)` : ''}${usage.firstTokenMs !== undefined ? `  ·  first ${usage.firstTokenMs}ms` : ''}` : '';
    const width = Math.max(1, Number(screen.width) - 2);
    const home = process.env.HOME ? resolvePath(process.env.HOME) : undefined;
    const cwd = runtime.workspace();
    const cwdText = home && cwd.startsWith(home + sep) ? `~${cwd.slice(home.length)}` : cwd;
    const left = `maw  ${activeModel}  ${cwdText}`;
    // Surface the mode-specific Ctrl+C semantics so the double-press quit is
    // never a surprise, and [side] marks a /btw conversation.
    const ctrlHint = isBtw() ? 'Ctrl+C back' : 'Ctrl+C x2 quit';
    // Cross-process state: a read-only badge when another process owns this
    // session, and a warning when other maw instances are live in the
    // same workspace (file conflicts are detected, not hidden).
    const access = runtime.sessionAccess(sessionId);
    const accessBadge = access.writable
      ? ''
      : `  {${COLOR().error}-fg}[read-only${access.holderPid ? ` pid ${access.holderPid}` : ''}]{/${COLOR().error}-fg}`;
    const instanceBadge = otherInstances.length
      ? `  {${COLOR().warning}-fg}⚠ ${otherInstances.length} other maw${otherInstances.length === 1 ? '' : 's'}{/${COLOR().warning}-fg}`
      : '';
    // A standing goal takes priority over the quit hint; the hint yields so
    // the goal never gets truncated below its floor.
    const right = session.goal
      ? `${activityText}${usageText}`
      : Number(screen.width) >= 78
        ? `${activityText}${usageText}  ·  Ctrl+K commands  ·  ${ctrlHint}`
        : `${activityText}${usageText}  ·  ${ctrlHint}`;
    const goal = session.goal;
    // The standing goal rides the right cluster so the layout stays a single
    // left/right split; a separate child widget would fight the statusbar's
    // setContent-based repaint. Its budget is whatever the left and right
    // clusters leave over, floored so it never collapses to nothing.
    const goalBudget = Math.max(8, width - Number(statusbar.strWidth(left)) - Number(statusbar.strWidth(right)) - 4);
    const goalText = goal ? `  ⚑ ${oneLine(goal, goalBudget)}` : '';
    const rightText = `${right}${goalText}`;
    const gap = width - Number(statusbar.strWidth(left)) - Number(statusbar.strWidth(rightText));
    statusbar.setContent(gap >= 3
      ? `{bold}maw{/bold}  {${COLOR().muted}-fg}${safe(activeModel)}{/${COLOR().muted}-fg}  {${COLOR().muted}-fg}${safe(cwdText)}{/${COLOR().muted}-fg}${isBtw() ? `  {${COLOR().accent}-fg}[side]{/${COLOR().accent}-fg}` : ''}${accessBadge}${instanceBadge}${' '.repeat(Math.max(0, gap))}{${active ? COLOR().accent : COLOR().muted}-fg}${safe(rightText)}{/${active ? COLOR().accent : COLOR().muted}-fg}`
      : `{bold}maw{/bold}${goal ? `  {${COLOR().accent}-fg}⚑ ${safe(oneLine(goal, goalBudget))}{/${COLOR().accent}-fg}` : ''}${active ? `  {${COLOR().accent}-fg}${active} active{/${COLOR().accent}-fg}` : ''}${activeTurnStep !== undefined ? `  {${COLOR().accent}-fg}step ${activeTurnStep}{/${COLOR().accent}-fg}` : ''}${accessBadge}${instanceBadge}`);
  };

  const conversationAtBottom = (): boolean => {
    const viewportHeight = Math.max(0, Number(conversation.height) - Number(conversation.iheight));
    const scrollHeight = conversation.getScrollHeight();
    if (scrollHeight <= viewportHeight) return true;
    return conversation.childBase >= scrollHeight - viewportHeight - 1;
  };

  // Conversation transcript buffer for the frame in flight. lineCursor tracks
  // the total number of rendered lines (split-aware) pushed so far, giving
  // O(1) anchors for click-to-expand hit-testing instead of rescanning the
  // whole buffer per entry.
  let conversationLines: string[] = [];
  let lineCursor = 0;
  const pushConversationLine = (line: string): void => {
    lineCursor += line.split('\n').length;
    conversationLines.push(line);
  };

  const renderConversation = (): void => {
    if (!conversationDirty) return;
    const previousScrollOffset = conversationScrollOffset;
    const shouldFollowOutput = conversationFollowOutput;
    conversationLines = [];
    lineCursor = 0;
    const screenWidth = typeof screen.width === 'number' ? screen.width : 80;
    const metrics = tuiLayout(screenWidth, activityVisible);
    const markdownCols = Math.max(10, Math.min(120, metrics.conversationWidth - metrics.horizontalPadding * 2 - 2));
    thinkingBlockLines.clear();
    stickyHeaderLines.clear();
    // The welcome screen yields to any conversation content — messages,
    // streaming output, thinking, or transcript entries like shell runs.
    const welcomeVisible = !session.messages.length && !streams.size && thinkingBlocks.size === 0 && !(session.timeline?.length);
    if (welcomeVisible) {
      // A committed theme change rebases the welcome clock so the mark replays
      // its opening act under the new palette; preview highlights and Esc/✕
      // rollbacks never set the flag, so they only recolor in place.
      if (themeIntroReplay) {
        themeIntroReplay = false;
        // Rebase the welcome clock: the next timer tick derives frame 1 from
        // this moment, and the loop's own shine phase restarts seamlessly
        // because every intro lands on the settled frame-20 state.
        welcomeStartedAt = performance.now();
        welcomeFrame = 0;
      }
      for (const line of renderWelcome(
        Number(conversation.width) - Number(conversation.iwidth) - 1,
        Number(conversation.height) - Number(conversation.iheight), Number(screen.height), welcomeFrame,
      )) pushConversationLine(line);
      if (!welcomeTimer) {
        welcomeStartedAt = performance.now();
        welcomeTimer = setInterval(() => {
          // Decoration only: frozen while blurred. A skipped frame leaves the
          // screen untouched, so it must not mark the frame stale.
          if (!windowFocused) return;
          if (nativeSelection || hasSelection() || screen.focused !== composer) return;
          // The frame derives from the monotonic clock instead of a counter:
          // after sleep or background suspension the animation lands on the
          // correct phase in one step, with no backlog of missed ticks.
          welcomeFrame = Math.floor((performance.now() - welcomeStartedAt) / 50);
          // The frame only reaches the screen if the conversation actually
          // re-renders; a bare refresh would early-return on a clean buffer.
          conversationDirty = true;
          scheduleRefresh();
        }, 50);
        welcomeTimer.unref?.();
      }
    } else {
      // The welcome screen is hidden: a pending replay would otherwise fire
      // stale months later (e.g. when /clear finally reveals the banner).
      themeIntroReplay = false;
      if (welcomeTimer) {
        clearInterval(welcomeTimer);
        welcomeTimer = undefined;
      }
    }
    const renderedBlocks = new Set<string>();
    if (session.timeline) {
      const { entries: visibleTimeline, omitted } = visibleTimelineEntries(session.timeline);
      if (omitted) {
        pushConversationLine(`{${COLOR().subtle}-fg}  ${omitted} earlier activity entries omitted from this view{/${COLOR().subtle}-fg}`);
        pushConversationLine('');
      }
      for (const entry of visibleTimeline) {
        if (entry.kind === 'message') {
          pushConversationLine('');
          if (entry.role === 'user') {
            pushConversationLine(`{${COLOR().accent}-fg}{bold}You{/bold}{/${COLOR().accent}-fg}`);
            pushConversationLine(safe(entry.content));
          } else if (entry.role === 'system') {
            pushConversationLine(`{${COLOR().warning}-fg}! ${safe(entry.content)}{/${COLOR().warning}-fg}`);
          } else {
            pushConversationLine(`{${COLOR().muted}-fg}{bold}TokenMaw{/bold}{/${COLOR().muted}-fg}`);
            pushConversationLine(renderTuiMarkdown(entry.content, markdownCols));
          }
          pushConversationLine('');
          continue;
        }
        if (entry.kind === 'shell') {
          // User-typed shell run: the command line wears a dedicated color so
          // it reads as a user action, not agent activity; the status glyph
          // keeps its own tone. Output streams beneath as plain text.
          pushConversationLine('');
          const running = entry.status === 'running';
          const commandColor = COLOR().warning;
          const stateLabel = running
            ? waitingIndicatorFrame(shellAnimationFrame, { accent: COLOR().accent, subtle: COLOR().subtle })
            : entry.status === 'failed'
              ? `✗ exit ${entry.exitCode ?? 1}`
              : entry.status === 'cancelled'
                ? '× stopped'
                : '✓';
          const iconColor = running ? COLOR().accent
            : entry.status === 'failed' ? COLOR().error
              : entry.status === 'cancelled' ? COLOR().muted : COLOR().success;
          pushConversationLine(`{${commandColor}-fg}{bold}! ${safe(entry.input ?? '')}{/bold}{/${commandColor}-fg} ${running ? stateLabel : `{${iconColor}-fg}${stateLabel}{/${iconColor}-fg}`}`);
          const outputLines = safe(entry.content).split('\n');
          const maxOutputLines = 400;
          if (outputLines.length > maxOutputLines) {
            pushConversationLine(`  {${COLOR().subtle}-fg}… ${outputLines.length - maxOutputLines} earlier output lines hidden{/${COLOR().subtle}-fg}`);
          }
          for (const line of outputLines.slice(-maxOutputLines)) {
            if (line.length > 0) pushConversationLine(`  ${line}`);
          }
          pushConversationLine('');
          continue;
        }
        const expanded = thinkingBlocks.get(entry.id)?.expanded ?? false;
        const previous = thinkingBlocks.get(entry.id);
        const block: ThinkingBlock = { turnId: entry.id, expanded, content: previous?.content ?? [],
          status: entry.status === 'running' ? 'active' : 'completed',
          thinking: entry.kind === 'thinking' ? entry.content : previous?.thinking,
          startedAt: previous?.startedAt ?? entry.startedAt ?? thinkingStartedAt.get(entry.turnId ?? '') ?? (entry.status === 'running' ? Date.now() : undefined),
          finishedAt: entry.status === 'running' ? undefined : previous?.finishedAt ?? entry.endedAt ?? Date.now() };
        thinkingBlocks.set(entry.id, block);
        if (entry.kind === 'thinking') {
          renderThinkingBlock(block);
        } else {
          const headerLine = lineCursor;
          latestThinkingTurnId = entry.id;
          const agent = entry.instanceId ? instanceCache.get(entry.instanceId)?.agentId : undefined;
          const state = entry.status === 'running'
            ? STATUS_PRESENTATION.running
            : entry.status === 'failed'
              ? STATUS_PRESENTATION.failed
              : entry.status === 'cancelled'
                ? STATUS_PRESENTATION.cancelled
                : STATUS_PRESENTATION.idle;
          const color = TONE_COLOR(state.tone);
          const presentation = toolPresentation(entry.tool ?? '', entry.input);
          const owner = agent && agent !== 'main' ? `${agent} · ` : '';
          const detail = presentation.detail ? `  ${oneLine(presentation.detail, Math.max(18, markdownCols - presentation.label.length - owner.length - 12))}` : '';
          const headerText = `{${color}-fg}${expanded ? '▾' : '▸'} ${state.icon}{/${color}-fg} {${COLOR().muted}-fg}${safe(owner)}${safe(presentation.label)}${safe(detail)}{/${COLOR().muted}-fg}`;
          pushConversationLine(headerText);
          stickyHeaderLines.set(entry.id, headerText);
          if (expanded) {
            if (entry.input) {
              pushConversationLine(`  {${COLOR().subtle}-fg}Input{/${COLOR().subtle}-fg}`);
              for (const line of safe(entry.input).split('\n')) pushConversationLine(`  ${line}`);
            }
            pushConversationLine(`  {${COLOR().subtle}-fg}${entry.status === 'running' ? 'Output · running' : 'Output'}{/${COLOR().subtle}-fg}`);
            for (const line of renderTuiMarkdown(entry.content || 'Waiting for output…', Math.max(10, markdownCols - 2)).split('\n')) pushConversationLine(`  ${line}`);
          } else {
            const patch = toolDiff(entry.tool ?? '', entry.content);
            if (patch) pushConversationLine(renderTuiMarkdown(diffPreview(patch), markdownCols));
            if (entry.status === 'failed') pushConversationLine(`  {${COLOR().error}-fg}${safe(oneLine(entry.content, markdownCols - 2))}{/${COLOR().error}-fg}`);
          }
          pushConversationLine('');
          // Recorded after the body so the pinned header vanishes once the
          // whole expanded block (not just its header) leaves the viewport top.
          thinkingBlockLines.set(entry.id, { headerLine, lastLine: Math.max(headerLine, lineCursor - 1) });
        }
      }
    }
    for (const message of session.timeline ? [] : session.messages) {
      const user = message.role === 'user';
      const content = message.role === 'assistant'
        ? renderTuiMarkdown(message.content, markdownCols)
        : safe(message.content);
      pushConversationLine('');
      if (user) {
        pushConversationLine(`{${COLOR().accent}-fg}{bold}You{/bold}{/${COLOR().accent}-fg}`);
        pushConversationLine(content);
      } else if (message.role === 'assistant') {
        pushConversationLine(`{${COLOR().muted}-fg}{bold}TokenMaw{/bold}{/${COLOR().muted}-fg}`);
        pushConversationLine(content);
      } else {
        pushConversationLine(`{${COLOR().warning}-fg}! ${content}{/${COLOR().warning}-fg}`);
      }
      pushConversationLine('');
      if (message.role === 'user' && message.turnId && thinkingBlocks.has(message.turnId)) {
        renderedBlocks.add(message.turnId);
        renderThinkingBlock(thinkingBlocks.get(message.turnId)!);
      }
    }
    if (isWaitingForFirstToken({
      pendingTurns: pendingTurns.size,
      streamingEntries: streams.size,
      runningTimelineEntries: [...(session.timeline ?? [])].filter((entry) => entry.status === 'running' && entry.kind !== 'tool' && entry.kind !== 'shell').length,
      sessionHasTimeline: Boolean(session.timeline),
    })) {
      // Only a confirmed thinking delta switches the slot to Thinking; until
      // then the ellipsis stands. Deltas emit through onEvent, which always
      // coalesces into a refresh via scheduleRefresh, so the very next frame
      // after the first reasoning token shows the Thinking header.
      const pendingBlock = [...thinkingBlocks.values()].reverse().find((block) => block.status === 'active' && block.thinking);
      if (pendingBlock) {
        renderThinkingBlock(pendingBlock);
      } else {
        pushConversationLine('');
        pushConversationLine(`{${COLOR().muted}-fg}{bold}TokenMaw{/bold}{/${COLOR().muted}-fg}`);
        pushConversationLine(waitingIndicatorFrame(waitingFrame, { accent: COLOR().accent, subtle: COLOR().subtle }));
        pushConversationLine('');
      }
    }
    if (!session.timeline && pendingTurns.size > 0) {
      const turnId = [...pendingTurns][0];
      if (!thinkingBlocks.has(turnId)) {
        thinkingBlocks.set(turnId, { turnId, expanded: false, content: [], status: 'active', startedAt: Date.now() });
        markThinkingStart(turnId);
      }
      if (!renderedBlocks.has(turnId)) {
        renderThinkingBlock(thinkingBlocks.get(turnId)!);
      }
    }
    for (const [turnId, text] of session.timeline ? [] : streams.entries()) {
      if (!text.trim()) continue;
      pushConversationLine('');
      pushConversationLine(`{${COLOR().muted}-fg}{bold}TokenMaw{/bold}{/${COLOR().muted}-fg}`);
      pushConversationLine(renderTuiMarkdown(text, markdownCols));
      pushConversationLine('');
    }
    if (notice) {
      pushConversationLine('');
      const noticeColor = /^Error\b|failed/i.test(notice) ? COLOR().error : COLOR().warning;
      pushConversationLine(`{${noticeColor}-fg}! ${safe(notice)}{/${noticeColor}-fg}`);
      pushConversationLine('');
    }
    restoringConversationScroll = true;
    try {
      conversation.setContent(conversationLines.join('\n'));
      if (welcomeVisible) {
        conversation.resetScroll();
      } else if (shouldFollowOutput) {
        conversation.scroll(conversation.getScrollHeight(), true);
      } else {
        conversation.scroll(Math.max(0, previousScrollOffset) - conversation.childBase, true);
      }
      conversationScrollOffset = conversation.childBase;
    } finally {
      restoringConversationScroll = false;
    }
    applyStickyHeader(conversation.childBase);
    conversationFollowOutput = shouldFollowOutput;
    conversationDirty = false;
  };

  // Pin the collapse header of an expanded block to the conversation top while
  // the user is reading that block's body. The pinned row is a fixed overlay on
  // the viewport's first row, and it disappears again as soon as the block's
  // real header scrolls back into view or the whole block scrolls past the top.
  const applyStickyHeader = (viewportTop: number): void => {
    const visibleRows = Math.max(1, Number(conversation.height) - Number(conversation.iheight));
    const scrollHeight = conversation.getScrollHeight();
    // Nothing is scrolled out of view when the content fits, so no block can
    // need a pinned header — fall through to the hide branch below so any
    // sticky row left over from before the content shrank is cleared too.
    let sticky: StickyHeader | undefined;
    if (scrollHeight > visibleRows) {
      const topRow = Math.max(0, Math.min(scrollHeight - visibleRows, viewportTop));
      const clines = (conversation as unknown as { _clines?: { ftor?: Array<unknown[]> } })._clines;
      // Block positions are logical content rows, but scrolling (childBase) is
      // counted in rendered rows: long wrapped lines make the two diverge.
      // Translate through ftor so the viewport is never considered to have
      // left a block it is still inside.
      const logicalSpan = (real: number): { first: number; last: number } => {
        const bucket = clines?.ftor?.[real];
        if (!bucket || bucket.length === 0) return { first: real, last: real };
        return { first: Number(bucket[0]), last: Number(bucket[bucket.length - 1]) };
      };
      const pinFor = (turnId: string, position: { headerLine: number; lastLine: number }): StickyHeader => {
        const line = stickyHeaderLines.get(turnId) ?? '';
        return {
          turnId,
          line,
          lastLine: logicalSpan(position.lastLine).last,
          // The redraw key excludes the spinner glyph: its 60ms animation must
          // not force full-screen reallocations, while label/duration changes
          // (which only grow or switch) still do.
          redrawKey: `${turnId} :: ${line.replace(spinnerGlyph(spinnerFrame), '')}`,
        };
      };
      // Keep the current sticky row only while its block still occupies the
      // viewport top: the real header sits above the top row and the block
      // body has not fully scrolled past it yet.
      const pos = stickyHeader ? thinkingBlockLines.get(stickyHeader.turnId) : undefined;
      const keptBlock = stickyHeader && pos ? thinkingBlocks.get(stickyHeader.turnId) : undefined;
      if (stickyHeader && pos && keptBlock?.expanded && stickyHeaderLines.has(stickyHeader.turnId)) {
        const header = logicalSpan(pos.headerLine);
        const tail = logicalSpan(pos.lastLine);
        if (header.first < topRow && tail.last >= topRow) {
          // Regenerate the row so a live block's spinner glyph and elapsed
          // seconds keep updating instead of freezing at the pinning frame.
          sticky = pinFor(stickyHeader.turnId, pos);
        }
      }
      if (!sticky) {
        // Several expanded blocks may sit above the viewport; the one to pin
        // is the unique block whose rendered span still contains the top row.
        for (const [turnId, position] of thinkingBlockLines) {
          const block = thinkingBlocks.get(turnId);
          if (!block?.expanded || !stickyHeaderLines.has(turnId)) continue;
          const header = logicalSpan(position.headerLine);
          const tail = logicalSpan(position.lastLine);
          if (header.first < topRow && tail.last >= topRow) {
            sticky = pinFor(turnId, position);
            break;
          }
        }
      }
    }
    invalidateStickyIfChanged(sticky);
    const conversationExt = conversation as blessed.Widgets.BoxElement & { _listWrapper?: blessed.Widgets.BoxElement };
    if (!sticky) {
      conversationExt._listWrapper?.hide();
      return;
    }
    // The pinned header is a fixed overlay anchored at the viewport's first
    // row; it does not consume a logical content row.
    conversationExt._listWrapper ??= (() => {
      // Full parent width plus the same left/right padding as the content
      // stream keeps the pinned header aligned with the real header row.
      // `fixed` exempts the overlay from the scrollable parent's childBase
      // offset, so it stays anchored at the viewport's top row instead of
      // scrolling out of view together with the conversation content.
      const wrapper = blessed.box({ parent: conversation, top: 0, left: 0, width: '100%', height: 1, tags: true, mouse: true, fixed: true, autoFocus: false, padding: { left: 2, right: 2 }, style: { bg: COLOR().background } });
      wrapper.on('click', () => {
        if (modalDepth > 0) return;
        // Blessed bubbles this click up to the conversation box; the flag
        // consumes the bubbled copy so the block is toggled exactly once.
        stickyClickHandled = true;
        if (hasSelection()) return;
        focusConversation();
        if (stickyHeader) toggleThinkingBlock(stickyHeader.turnId);
      });
      return wrapper;
    })();
    stickyHeader = sticky;
    conversationExt._listWrapper.show();
    conversationExt._listWrapper.setContent(sticky.line);
  };

  const renderThinkingBlock = (block: ThinkingBlock): void => {
    const headerLine = lineCursor;
    const toggle = block.expanded ? '▾' : '▸';
    // Completed blocks reuse the toggle glyph as their icon; keep only one so
    // the header never shows "▾ ▾" or "▸ ▸".
    const icon = block.status === 'active' ? spinnerGlyph(spinnerFrame) : '';
    const color = block.status === 'active' ? COLOR().accent : COLOR().muted;
    // An active block with nothing to show yet is the pre-first-token state:
    // the model is reasoning, so label it Thinking, not Working.
    const label = block.status === 'active'
      ? (block.thinking || block.content.length === 0 ? 'Thinking' : 'Working')
      : (block.thinking ? 'Thought' : 'Activity');
    const duration = elapsedLabel(block.startedAt, block.finishedAt);
    const durationText = duration ? `  ${duration}` : '';
    let headerText: string;
    if (block.status === 'active') {
      const scanLabel = `{${COLOR().accent}-fg}${label}{/${COLOR().accent}-fg}`;
      headerText = `{${color}-fg}${toggle} ${icon}{/${color}-fg} ${scanLabel}{${COLOR().subtle}-fg}${durationText}{/${COLOR().subtle}-fg}`;
    } else {
      headerText = `{${color}-fg}${toggle}${icon ? ` ${icon}` : ''} ${label}${durationText}{/${color}-fg}`;
    }
    pushConversationLine(headerText);
    stickyHeaderLines.set(block.turnId, headerText);
    latestThinkingTurnId = block.turnId;
    if (block.expanded) {
      if (block.thinking) {
        for (const line of safe(block.thinking).split('\n')) pushConversationLine(`  ${line}`);
        pushConversationLine('');
      }
      const content = block.content.length > 0 ? block.content : block.thinking ? [] : ['Waiting for activity…'];
      for (const c of content) {
        const rendered = c.includes('```diff\n')
          ? renderTuiMarkdown(c, Math.max(10, Number(conversation.width) - 8))
          : safe(c);
        for (const line of rendered.split('\n')) pushConversationLine(`  ${line}`);
      }
    }
    pushConversationLine('');
    // Recorded after the whole block is pushed so `lastLine` covers the body;
    // the pinned header must vanish once this row scrolls past the viewport top.
    thinkingBlockLines.set(block.turnId, { headerLine, lastLine: Math.max(0, lineCursor - 1) });
  };

  const renderActivity = (): void => {
    if (activityDetail) {
      const instance = instanceCache.get(activityDetail.instanceId);
      if (instance) activityDetail.body.setContent(activityDetailContent(instance));
    }
    if (!activityDirty) return;
    const current = instances();
    const activeCount = current.filter((item) => ['running', 'waiting', 'queued'].includes(item.status)).length;
    activityHeader.setContent(`{bold}Activity{/bold}{${COLOR().muted}-fg}${activeCount ? `  ${activeCount} active` : ''}{/${COLOR().muted}-fg}\n{${COLOR().subtle}-fg}Click an agent to view progress{/${COLOR().subtle}-fg}\n{${COLOR().subtle}-fg}${'─'.repeat(Math.max(0, Number(activity.width) - 2))}{/${COLOR().subtle}-fg}`);
    activity.setItems(current.map((instance) => {
      const state = STATUS_PRESENTATION[instance.status];
      const summary = instance.lastError || activityLog.get(instance.instanceId)?.at(-1) || instance.lastOutput;
      const fixedWidth = instance.depth * 2 + instance.agentId.length + state.label.length + 6;
      const detail = oneLine(summary, Math.max(0, Number(activity.width) - fixedWidth));
      return `${depthPrefix(instance)} {bold}${safe(instance.agentId)}{/bold}  {${TONE_COLOR(state.tone)}-fg}${state.label}{/${TONE_COLOR(state.tone)}-fg}${detail ? `  {${COLOR().subtle}-fg}${safe(detail)}{/${COLOR().subtle}-fg}` : ''}`;
    }));
    activityDirty = false;
  };

  const layout = (): void => {
    const metrics = tuiLayout(Number(screen.width), activityVisible);
    const layoutKey = `${metrics.activity}:${metrics.activityWidth}:${metrics.conversationWidth}:${metrics.horizontalPadding}:${Number(screen.height)}`;
    if (layoutKey !== lastLayoutKey) {
      lastLayoutKey = layoutKey;
      conversationDirty = true;
      activityDirty = true;
      requestFullRedraw();
    }
    const conversationBox = conversation as blessed.Widgets.BoxElement & { padding: { left: number; right: number } };
    conversationBox.padding.left = metrics.horizontalPadding;
    conversationBox.padding.right = metrics.horizontalPadding;
    if (metrics.activity !== 'hidden') {
      activity.show();
      activityHeader.show();
      activity.width = metrics.activityWidth;
      activityHeader.width = metrics.activityWidth;
      conversation.width = metrics.conversationWidth;
      if (metrics.activity === 'overlay') {
        activity.setFront();
        activityHeader.setFront();
      }
    } else {
      activity.hide();
      activityHeader.hide();
      conversation.width = '100%';
    }
    composer.width = '100%-4';
    composerPrompt.left = 1;
  };

  // Streaming chunks, spinner ticks, and animation frames can fire many times
  // per macrotask; coalesce them into at most one full repaint per tick.
  let refreshScheduled = false;
  const scheduleRefresh = (): void => {
    if (refreshScheduled || closed) return;
    refreshScheduled = true;
    setImmediate(() => {
      refreshScheduled = false;
      refresh();
    });
  };

  const refresh = (): void => {
    if (closed) return;
    if (hasSelection()) return;
    layout();
    renderComposer();
    renderStatus();
    renderConversation();
    renderActivity();
    const composerFocused = composerPinned;
    if (composerFocused && screen.focused !== composer) composer.focus();
    if (composerFocused) screen.program.hideCursor();
    // Overlay scrollbars must be positioned before the render pass that
    // paints them.
    conversationScrollbar.sync();
    activityScrollbar.sync();
    activityDetailScrollbar.current?.sync();
    renderScreen(composerFocused ? syncComposerCursor : undefined);
  };

  // Focus regained is treated like a resize, and only when the blur window
  // actually skipped frames: one invalidate + full redraw rebuilds blessed's
  // diff buffers, the viewport, and the overlay scrollbar positions from the
  // live state instead of a stale frame. Skipping it when nothing was skipped
  // keeps short refocuses byte-quiet (no replay burst, no scrolling flash).
  screen.program.on('focus', () => {
    windowFocused = true;
    if (!blurredStale) return;
    blurredStale = false;
    requestFullRedraw();
    conversationDirty = true;
    scheduleRefresh();
  });
  screen.program.on('blur', () => {
    windowFocused = false;
  });

  const applyModel = async (alias: string): Promise<void> => {
    const resolved = options.resolveModel(alias);
    if (!resolved.config.model) throw new Error('Selected model is not configured.');
    await options.persistModelSelection?.(alias);
    runtime.setDefaultModel(alias);
    await runtime.setSessionDefaultModel(sessionId, alias);
    activeModel = resolved.name;
    refresh();
  };

  // Provider/model management lives in provider-models.ts: saved providers
  // hold the connection once (URL + key), models reference them, and
  // /provider walks providers → their models without ever re-asking for a
  // stored URL or key.
  const { openProvider, openModel } = createProviderFlows({
    configManager: options.configManager,
    choose: (title, items, chooseOptions) => choose(title, [...items], chooseOptions),
    ask,
    notify: (message) => { notice = message; refresh(); },
    applyModel,
    activeModel: () => activeModel,
    modelAliases: options.modelAliases,
  });

  const showAgents = async (): Promise<void> => {
    const specs = runtime.listAgentSpecs();
    const index = await choose('Agent specs', specs.map((spec) => ({
      label: spec.id,
      detail: `${spec.scope} · ${spec.model ?? 'inherit'} · ${oneLine(spec.description, 42)}`,
    })), { searchable: true });
    if (index < 0) return;
    const spec = specs[index]!;
    await choose(spec.id, [
      `source  ${spec.source}`,
      `model   ${spec.model ?? 'inherit'}`,
      `tools   ${spec.tools.join(', ') || 'none'}`,
      `agents  ${spec.agents.join(', ') || 'none'}`,
      'Close',
    ]);
  };

  const switchSession = async (id: string, opts: { forkFrom?: string; parentSessionId?: string } = {}): Promise<void> => {
    if (opts.forkFrom) {
      // /btw and /fork both start as a full copy of the current conversation,
      // so the side model keeps the whole picture from message one.
      await runtime.forkSession(opts.forkFrom, id);
    }
    const next = await runtime.openSession(id);
    sessionId = id;
    session = next;
    instanceCache.clear();
    for (const instance of runtime.listInstances(id)) instanceCache.set(instance.instanceId, instance);
    activityDirty = true;
    activeModel = session.defaultModel ?? options.modelName;
    streams.clear();
    activityLog.clear();
    thinkingBlocks.clear();
    thinkingBlockLines.clear();
    stickyHeaderLines.clear();
    thinkingStartedAt.clear();
    pendingTurns.clear();
    activeTurnStep = undefined;
    stickyHeader = undefined;
    lastStickyKey = undefined;
    (conversation as blessed.Widgets.BoxElement & { _listWrapper?: blessed.Widgets.BoxElement })._listWrapper?.hide();
    notice = '';
    conversationDirty = true;
    conversationFollowOutput = true;
    conversationScrollOffset = 0;
    restoreThinking();
    for (const instance of instances()) {
      if (instance.instanceId === session.mainInstanceId && instance.activeTurnId) pendingTurns.add(instance.activeTurnId);
    }
    sideParentSessionId = opts.parentSessionId;
    startSpinner();
    startStreamTimer();
    refresh();
  };

  const openSessions = async (): Promise<void> => {
    const sessions = await runtime.listSessions();
    const index = await choose('Sessions', [
      ...sessions.map((item) => ({
        label: oneLine(item.preview, 52) || item.sessionId,
        detail: `${item.messages} msg · ${item.relativeUpdatedAt ?? ''} · ${item.sessionId}${item.sessionId.startsWith('btw-') ? ' [side]' : ''}`,
      })),
      { label: 'New session', detail: 'Start a blank conversation' },
    ], { searchable: true });
    if (index < 0) return;
    await switchSession(index === sessions.length ? `session-${Date.now()}` : sessions[index]!.sessionId);
  };

  const activityDetailContent = (instance: AgentInstance): string => {
    const state = STATUS_PRESENTATION[instance.status];
    const stateColor = TONE_COLOR(state.tone);
    const source = runtime.registry.get(instance.agentId)?.source ?? 'built in';
    const lines = [
      `{${stateColor}-fg}${state.icon} ${state.label}{/${stateColor}-fg}  {${COLOR().subtle}-fg}${safe(instance.instanceId.slice(0, 8))}{/${COLOR().subtle}-fg}`,
      `{${COLOR().subtle}-fg}Source{/${COLOR().subtle}-fg}  ${safe(source)}`,
      `{${COLOR().subtle}-fg}Updated{/${COLOR().subtle}-fg} ${safe(new Date(instance.updatedAt).toLocaleTimeString())}`,
      '',
      '{bold}Progress{/bold}',
    ];
    const entries = (session.timeline ?? []).filter((entry) => entry.instanceId === instance.instanceId && entry.kind !== 'message').slice(-30);
    if (entries.length) {
      for (const entry of entries) {
        if (entry.kind === 'thinking') {
          lines.push(`{${entry.status === 'running' ? COLOR().accent : COLOR().subtle}-fg}… Thinking{/${entry.status === 'running' ? COLOR().accent : COLOR().subtle}-fg}  ${safe(oneLine(entry.content, 140) || 'Waiting…')}`);
          continue;
        }
        const itemState = entry.status === 'running'
          ? STATUS_PRESENTATION.running
          : entry.status === 'failed'
            ? STATUS_PRESENTATION.failed
            : entry.status === 'cancelled'
              ? STATUS_PRESENTATION.cancelled
              : STATUS_PRESENTATION.idle;
        const presentation = toolPresentation(entry.tool ?? '', entry.input);
        const detail = presentation.detail || oneLine(entry.content, 120);
        lines.push(`{${TONE_COLOR(itemState.tone)}-fg}${itemState.icon} ${safe(presentation.label)}{/${TONE_COLOR(itemState.tone)}-fg}${detail ? `  {${COLOR().muted}-fg}${safe(oneLine(detail, 140))}{/${COLOR().muted}-fg}` : ''}`);
      }
    } else {
      const log = activityLog.get(instance.instanceId) ?? [];
      if (log.length) lines.push(...log.slice(-20).map((item) => `{${COLOR().muted}-fg}· ${safe(item)}{/${COLOR().muted}-fg}`));
      else lines.push(`{${COLOR().subtle}-fg}No progress events yet.{/${COLOR().subtle}-fg}`);
    }
    if (instance.lastError) lines.push('', `{${COLOR().error}-fg}! ${safe(oneLine(instance.lastError, 240))}{/${COLOR().error}-fg}`);
    else if (instance.lastOutput) lines.push('', `{${COLOR().subtle}-fg}Latest output{/${COLOR().subtle}-fg}`, safe(oneLine(instance.lastOutput, 240)));
    return lines.join('\n');
  };

  const showActivityDetail = async (): Promise<void> => {
    const instance = instances()[selectedActivityIndex];
    if (!instance) return;
    if (activityDetail) modalDepth = Math.max(0, modalDepth - 1);
    activityDetail?.modal.destroy();
    composerPinned = false;
    modalDepth++;
    const width = Math.min(88, Math.max(36, Number(screen.width) - 6));
    const height = Math.min(24, Math.max(9, Number(screen.height) - 4));
    const modal = blessed.box({
      parent: screen, top: 'center', left: 'center', width, height,
      tags: true, clickable: true, autoFocus: false, style: { bg: COLOR().modal, fg: COLOR().text },
    });
    modal.on('click', showModalSurfaceGuard);
    blessed.box({
      parent: modal, top: 0, left: 2, right: 2, height: 1, tags: true,
      content: `{bold}${safe(instance.agentId)} progress{/bold}`,
      style: { bg: COLOR().modal, fg: COLOR().text },
    });
    blessed.box({
      parent: modal, top: 1, left: 2, right: 2, height: 1,
      content: '─'.repeat(Math.max(0, width - 4)), style: { bg: COLOR().modal, fg: COLOR().modalRule },
    });
    const body = blessed.box({
      parent: modal, top: 3, left: 2, right: 2, bottom: 2,
      tags: true, keys: true, vi: true, mouse: true, scrollable: true, alwaysScroll: true,
      style: { bg: COLOR().modal, fg: COLOR().text },
      content: activityDetailContent(instance),
    });
    blessed.box({
      parent: modal, bottom: 0, left: 2, right: 2, height: 1,
      content: 'Scroll to browse  ·  Esc close', style: { bg: COLOR().modal, fg: COLOR().subtle },
    });
    const closeDetail = (): void => {
      if (activityDetail?.modal !== modal) return;
      activityDetailScrollbar.current?.destroy();
      activityDetailScrollbar.current = undefined;
      activityDetail = undefined;
      modal.destroy();
      requestFullRedraw();
      restoreModalFocus();
    };
    body.key(['escape', 'q'], closeDetail);
    attachCloseButton(modal, closeDetail);
    activityDetailScrollbar.current = attachPillScrollbar(body, pillColors);
    activityDetail = { instanceId: instance.instanceId, modal, body };
    body.focus();
    requestFullRedraw();
    activityDetailScrollbar.current.sync();
    renderScreen();
  };

  // Swaps the active palette and repaints every surface without persisting;
  // used both to commit a choice and to preview while browsing the picker.
  const applyThemeVisuals = (name: string): TuiTheme => {
    const next = setActiveTheme(name);
    resetTuiMarkdownCache();
    applyWidgetTheme();
    conversationDirty = true;
    activityDirty = true;
    requestFullRedraw();
    return next;
  };

  // Commits a theme choice. `changed` must be decided against the theme the
  // picker was opened with, not the live one: previewing already swaps the
  // active palette, so by Enter/click time it equals the chosen name. Any
  // commit path that actually changes the theme (Enter, mouse click, or a
  // future caller) replays the welcome logo's opening act under the new
  // palette; preview highlights and Esc/✕ rollbacks never do.
  const applyTheme = async (name: string, changed = activeTuiTheme().name !== name): Promise<void> => {
    const next = applyThemeVisuals(name);
    if (changed) themeIntroReplay = true;
    notice = `Theme set to ${next.label}`;
    await options.configManager.saveConfig({ ...options.configManager.getConfig(), theme: next.name });
    refresh();
  };

  const openTheme = async (): Promise<void> => {
    const original = activeTuiTheme().name;
    const names = themeNames();
    const index = await choose('Theme', names.map((name) => ({
      label: `${name}${name === original ? '  ✓' : ''}`,
      detail: resolveTheme(name).label,
    })), {
      searchable: true,
      // Open with the active theme preselected so browsing starts from where
      // the user is, not from the top of an arbitrary list.
      initial: Math.max(0, names.indexOf(original)),
      onHighlight: (highlight) => {
        const name = names[highlight];
        if (name && name !== activeTuiTheme().name) {
          applyThemeVisuals(name);
          refresh();
        }
      },
    });
    if (index >= 0) {
      await applyTheme(names[index]!, names[index] !== original);
    } else if (activeTuiTheme().name !== original) {
      // Picker dismissed: roll back to the theme chosen before previewing.
      applyThemeVisuals(original);
      refresh();
    }
  };

  const command = async (raw: string): Promise<void> => {
    const [name = '', ...args] = raw.slice(1).trim().split(/\s+/);
    switch (name.toLowerCase()) {
      case 'provider': await openProvider(); break;
      case 'model': await openModel(); break;
      case 'agents': await showAgents(); break;
      case 'theme': await openTheme(); break;
      case 'sessions': await openSessions(); break;
      case 'new': await switchSession(`session-${Date.now()}`); break;
      case 'clear':
        await runtime.clearSession(sessionId);
        session.messages = [];
        session.timeline = [];
        instanceCache.clear();
        for (const instance of runtime.listInstances(sessionId)) instanceCache.set(instance.instanceId, instance);
        activityDirty = true;
        streams.clear();
        thinkingBlocks.clear();
        thinkingBlockLines.clear();
        stickyHeaderLines.clear();
        thinkingStartedAt.clear();
        pendingTurns.clear();
        stickyHeader = undefined;
        lastStickyKey = undefined;
        (conversation as blessed.Widgets.BoxElement & { _listWrapper?: blessed.Widgets.BoxElement })._listWrapper?.hide();
        notice = '';
        conversationDirty = true;
        refresh();
        break;
      case 'cancel': {
        // The notice renders in the conversation stream; without flagging the
        // dirty bit renderConversation() skips the repaint entirely and the
        // acknowledgement never shows.
        if (!args[0]) { await runtime.cancelSession(sessionId); conversationDirty = true; notice = 'Stopped. Send a message to continue.'; refresh(); break; }
        const target = instances().find((item) => item.instanceId === args[0] || item.instanceId.startsWith(args[0] ?? ''));
        const main = runtime.getInstance(session.mainInstanceId);
        if (target && main && target.instanceId !== main.instanceId) await runtime.cancelAgent(main.instanceId, target.instanceId);
        break;
      }
      case 'compact': {
        try {
          notice = await runtime.compactInstance(session.mainInstanceId, { focus: args.length ? args.join(' ') : undefined });
        } catch (error) {
          notice = `Compact failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        refresh();
        break;
      }
      // /btw opens a self-contained side conversation forked from this one
      // (/back or Ctrl+C returns); /fork copies the whole conversation into a
      // new saved session. /goal sets a standing directive shown in the status
      // bar and injected into every agent's prompt until cleared.
      case 'btw': {
        const question = args.join(' ').trim();
        if (!question) { notice = 'Usage: /btw <question> - opens a side conversation; /back or Ctrl+C returns'; refresh(); break; }
        await switchSession(`btw-${Date.now()}`, { forkFrom: sessionId, parentSessionId: sessionId });
        await runtime.submitMessage(sessionId, question);
        break;
      }
      case 'back': {
        if (!sideParentSessionId) { notice = 'Not in a /btw side conversation.'; refresh(); break; }
        await switchSession(sideParentSessionId);
        break;
      }
      case 'fork': {
        await switchSession(`session-${Date.now()}`, { forkFrom: sessionId });
        break;
      }
      case 'goal': {
        const result = await runtime.setSessionGoal(sessionId, args.join(' '));
        session.goal = runtime.getSession(sessionId)?.goal;
        notice = result.detail;
        refresh();
        break;
      }
      // /board shows the shared session scratchpad; add/todo/clear manage it
      // from the keyboard. The agent owns day-to-day upkeep, this is for the
      // user to pin requirements or prune a full board.
      case 'board': {
        const [sub = '', ...rest] = args;
        const value = rest.join(' ').trim();
        if (!sub) {
          const entries = await runtime.boardEntries(sessionId);
          if (!entries.length) {
            notice = 'Session board is empty. /board add <text> or /board todo <text>.';
            refresh();
            break;
          }
          await choose('Session board', [
            ...entries.map((entry) => ({
              label: `[${entry.id}] ${entry.kind ?? 'note'}${entry.status ? ` · ${entry.status}` : ''}`,
              detail: oneLine(entry.text, 56),
            })),
            'Close',
          ], { searchable: true });
          break;
        }
        if (sub === 'add' || sub === 'todo') {
          if (!value) { notice = `Usage: /board ${sub} <text>`; refresh(); break; }
          const entry = await runtime.addBoardEntry(sessionId, value, sub === 'todo' ? { kind: 'todo', status: 'open' } : {});
          session.board = runtime.getSession(sessionId)?.board;
          notice = `Board entry ${entry.id} added.`;
          refresh();
          break;
        }
        if (sub === 'clear') {
          const count = await runtime.clearBoard(sessionId);
          session.board = runtime.getSession(sessionId)?.board;
          notice = `Board cleared (${count} ${count === 1 ? 'entry' : 'entries'} removed).`;
          refresh();
          break;
        }
        notice = 'Usage: /board | /board add <text> | /board todo <text> | /board clear';
        refresh();
        break;
      }
      case 'cd': {
        const target = args.join(' ').trim();
        if (!target) { notice = `Working directory: ${runtime.workspace()}`; refresh(); break; }
        try {
          const result = await runtime.changeWorkspace(target, { sessionId });
          notice = `Working directory: ${result.to}`;
          refresh();
        } catch (error) {
          notice = `cd failed: ${error instanceof Error ? error.message : String(error)}`;
          refresh();
        }
        break;
      }
      // Managed worktrees: /worktree <name> creates (or reopens) an isolated
      // checkout under .coder/worktrees/<name> and moves this session into it,
      // /worktree-list shows status, /worktree-exit returns to the main
      // checkout, /worktree-remove <name> drops a clean worktree.
      case 'worktree': {
        const name = args.join(' ').trim();
        if (!name) {
          const manager = new WorktreeManager(runtime.workspace());
          const here = await manager.containing(runtime.workspace());
          notice = here ? `In worktree ${here.name} (${here.branch})${here.dirty ? ' · dirty' : ''}` : 'Usage: /worktree <name>';
          refresh();
          break;
        }
        try {
          const manager = new WorktreeManager(runtime.workspace());
          if (!await manager.isGitRepository()) throw new Error('not inside a git repository');
          const info = await manager.create(name);
          await runtime.changeWorkspace(info.path, { sessionId });
          notice = `Worktree ready: ${info.path} (${info.branch})`;
          refresh();
        } catch (error) {
          notice = `worktree failed: ${error instanceof Error ? error.message : String(error)}`;
          refresh();
        }
        break;
      }
      case 'worktree-list': {
        try {
          const manager = new WorktreeManager(runtime.workspace());
          const all: WorktreeInfo[] = await manager.list();
          const here = await manager.containing(runtime.workspace());
          if (!all.length) { notice = 'No managed worktrees. /worktree <name> creates one.'; refresh(); break; }
          const lines = all.map((info) => `${info.name === here?.name ? '▸' : ' '} ${info.name}  ${info.branch}${info.dirty ? '  [dirty]' : ''}${info.locked ? '  [locked]' : ''}`);
          notice = lines.join('   ·   ');
          refresh();
        } catch (error) {
          notice = `worktree-list failed: ${error instanceof Error ? error.message : String(error)}`;
          refresh();
        }
        break;
      }
      case 'worktree-exit': {
        try {
          const manager = new WorktreeManager(runtime.workspace());
          const here = await manager.containing(runtime.workspace());
          if (!here) { notice = 'Not inside a managed worktree.'; refresh(); break; }
          await manager.unlock(here.name);
          const main = await manager.mainRoot();
          await runtime.changeWorkspace(main, { sessionId });
          notice = `Back in main checkout: ${main} (worktree ${here.name} kept on disk)`;
          refresh();
        } catch (error) {
          notice = `worktree-exit failed: ${error instanceof Error ? error.message : String(error)}`;
          refresh();
        }
        break;
      }
      case 'worktree-remove': {
        const name = args.join(' ').trim();
        if (!name) { notice = 'Usage: /worktree-remove <name>'; refresh(); break; }
        try {
          const manager = new WorktreeManager(runtime.workspace());
          await manager.remove(name);
          notice = `Removed worktree ${name} (branch kept).`;
          refresh();
        } catch (error) {
          notice = `worktree-remove failed: ${error instanceof Error ? error.message : String(error)}`;
          refresh();
        }
        break;
      }
      // Alias for `/cd` with no argument; arguments are ignored, like pwd.
      case 'pwd': {
        notice = `Working directory: ${runtime.workspace()}`;
        refresh();
        break;
      }
      case 'help': await commandPalette(); break;
      case 'select': setMouseInteraction(false); break;
      case 'mouse': setMouseInteraction(nativeSelection); break;
      case 'exit': case 'quit': close(); break;
      default: await choose('Unknown command', [`/${name} is not available`, 'Close']);
    }
  };

  const commandPalette = async (): Promise<void> => {
    const actions = [
      { label: 'Provider', detail: 'Manage model endpoints' },
      { label: 'Model', detail: 'Choose the session model' },
      { label: 'Theme', detail: 'Switch the color theme' },
      { label: 'Agent specs', detail: 'Inspect effective roles and permissions' },
      { label: 'Sessions', detail: 'Open a saved conversation' },
      { label: 'New session', detail: 'Start a blank conversation' },
      { label: 'Clear conversation', detail: 'Remove messages from this session' },
      { label: 'Compact context', detail: 'Archive older model context' },
      { label: 'Toggle activity', detail: 'Show or hide the agent tree' },
      { label: 'Exit', detail: 'Close TokenMaw' },
    ];
    const index = await choose('Command palette', actions, { searchable: true });
    if (index === 0) await openProvider();
    if (index === 1) await openModel();
    if (index === 2) await openTheme();
    if (index === 3) await showAgents();
    if (index === 4) await openSessions();
    if (index === 5) await switchSession(`session-${Date.now()}`);
    if (index === 6) await command('/clear');
    if (index === 7) await command('/compact');
    if (index === 8) { activityVisible = !activityVisible; refresh(); }
    if (index === 9) close();
  };

  const submit = async (): Promise<void> => {
    const value = composerValue().trim();
    if (!value) { focusComposer(); return; }
    // A submit and a Ctrl+C park can interleave: if the draft changed under
    // us, the user just parked a new draft — drop this stale submit.
    if (value !== composerValue().trim()) return;
    if (!inputHistory.includes(value)) inputHistory.push(value);
    setComposerValue('');
    focusComposer();
    try {
      if (value.startsWith('/')) await command(value);
      // Shell mode: `!cmd` runs directly in the workspace, outside the agent
      // loop and tool policy. Output streams in a popup and never reaches the
      // model context.
      else if (value.startsWith('!')) {
        const shellCommand = value.slice(1).trim();
        if (!shellCommand) notice = 'Usage: !<command> runs it in the workspace shell.';
        else await runShellMode(shellCommand);
      }
      else {
        notice = '';
        conversationFollowOutput = true;
        const turnId = await runtime.submitMessage(sessionId, value);
        const main = runtime.getInstance(session.mainInstanceId);
        if (main && ['running', 'queued', 'waiting'].includes(main.status)) pendingTurns.add(turnId);
        if (pendingTurns.has(turnId) && !thinkingBlocks.has(turnId)) {
          thinkingBlocks.set(turnId, { turnId, expanded: false, content: [], status: 'active', startedAt: Date.now() });
          markThinkingStart(turnId);
        }
        startSpinner();
        startStreamTimer();
        refresh();
      }
    } catch (error) {
      await choose('Error', [error instanceof Error ? error.message : String(error), 'Close']);
    }
    refresh();
    focusComposer();
  };

  const onEvent = (event: AgentEvent): void => {
    const eventSession = 'sessionId' in event ? event.sessionId : 'instance' in event ? event.instance.sessionId : 'instanceId' in event && event.instanceId ? instanceCache.get(event.instanceId)?.sessionId ?? runtime.getInstance(event.instanceId)?.sessionId : event.type === 'session_opened' ? event.session.sessionId : undefined;
    if (eventSession && eventSession !== sessionId) return;
    if (event.type === 'instance_created' || event.type === 'instance_updated') {
      instanceCache.set(event.instance.instanceId, event.instance);
      activityDirty = true;
    }
    if (event.type === 'user_message' && !session.messages.some((message) => message.messageId === event.message.messageId)) {
      session.messages.push({ ...event.message });
    }
    if (event.type === 'assistant_message' && !session.messages.some((message) => message.messageId === event.message.messageId)) {
      session.messages.push({ ...event.message });
    }
    if (event.type === 'system_message') {
      // System notices render only in the timeline stream, never in the
      // persisted message list; recordTimeline dedupes by messageId.
      conversationDirty = true;
    }
    recordTimeline(session, event);
    if (event.type === 'thinking_delta') {
      conversationDirty = true;
      markThinkingStart(event.turnId);
      const block = thinkingBlocks.get(event.turnId) ?? [...thinkingBlocks.values()].reverse().find((item) => item.status === 'active') ?? thinkingBlocks.get(latestThinkingTurnId ?? '');
      if (block) block.thinking = `${block.thinking ?? ''}${event.text}`;
      // Deltas can burst faster than a usable frame rate; the turn timer paints
      // them at a steady cadence so a markdown re-render runs at most ~10fps.
      if (streamTimer) return;
    }
    if (event.type === 'assistant_delta') {
      conversationDirty = true;
      streams.set(event.turnId, `${streams.get(event.turnId) ?? ''}${event.text}`);
      if (streamTimer) return;
    }
    if (event.type === 'assistant_message') {
      conversationDirty = true;
      streams.delete(event.message.turnId ?? '');
    }
    if (event.type === 'tool_started' || event.type === 'tool_finished') {
      conversationDirty = true;
      activityDirty = true;
      const log = activityLog.get(event.instanceId) ?? [];
      log.push(`${event.tool}  ${oneLine(event.type === 'tool_started' ? event.input : event.output, 120)}`);
      activityLog.set(event.instanceId, log.slice(-100));
    }
    if (event.type === 'tool_started') {
      const block = thinkingBlocks.get(event.turnId) ?? [...thinkingBlocks.values()].reverse().find(b => b.status === 'active') ?? thinkingBlocks.get(latestThinkingTurnId ?? '');
      if (block) {
        const agent = runtime.getInstance(event.instanceId)?.agentId;
        block.content.push(`→ ${agent && agent !== 'main' ? `${agent} · ` : ''}${event.tool}  ${oneLine(event.input, 60)}`);
      }
    }
    if (event.type === 'tool_finished') {
      const block = thinkingBlocks.get(event.turnId) ?? [...thinkingBlocks.values()].reverse().find(b => b.status === 'active') ?? thinkingBlocks.get(latestThinkingTurnId ?? '');
      if (block) {
        block.content.push(`✓ ${event.tool}  ${oneLine(event.output, 60)}`);
        const patch = toolDiff(event.tool, event.output);
        if (patch) block.content.push(patch);
      }
    }
    if (event.type === 'context_compacted' && event.sessionId === sessionId) {
      conversationDirty = true;
      const label = event.instanceId === session.mainInstanceId
        ? 'Context compacted'
        : `${runtime.getInstance(event.instanceId)?.agentId ?? 'agent'} context compacted`;
      notice = `${label} (${event.reason}): archived ${event.archivedMessages} messages, ${event.charsBefore} → ${event.charsAfter} chars.`;
    }
    if (event.type === 'runtime_error') {
      conversationDirty = true;
      if (event.sessionId === sessionId && event.instanceId === session.mainInstanceId) {
        notice = `Error: ${event.error}`;
        pendingTurns.clear();
        stopSpinner();
        stopStreamTimer();
      }
    }
    if (event.type === 'turn_progress' && event.sessionId === sessionId && event.instanceId === session.mainInstanceId) {
      activeTurnStep = event.step;
    }
    if (event.type === 'instance_updated' && event.instance.instanceId === session.mainInstanceId
      && event.instance.activeTurnId && ['running', 'waiting'].includes(event.instance.status)) {
      const turnId = event.instance.activeTurnId;
      conversationDirty = true;
      activeTurnStep = undefined;
      pendingTurns.clear();
      pendingTurns.add(turnId);
      for (const [id, block] of thinkingBlocks) {
        if (id !== turnId) { block.status = 'completed'; block.finishedAt = Date.now(); streams.delete(id); }
      }
      if (!thinkingBlocks.has(turnId)) thinkingBlocks.set(turnId, { turnId, expanded: false, content: [], status: 'active', startedAt: Date.now() });
      markThinkingStart(turnId);
      startSpinner();
      startStreamTimer();
    }
    if (event.type === 'instance_updated'
      && event.instance.sessionId === sessionId
      && event.instance.instanceId === session.mainInstanceId
      && ['idle', 'failed', 'cancelled'].includes(event.instance.status)) {
      const block = [...thinkingBlocks.values()].find(b => b.status === 'active');
      conversationDirty = true;
      activeTurnStep = undefined;
      if (block) {
        block.status = 'completed';
        block.finishedAt = Date.now();
      }
      pendingTurns.clear();
      streams.clear();
      stopSpinner();
      stopStreamTimer();
    }
    scheduleRefresh();
  };

  // `!command` shell mode. Output streams inline into the conversation as a
  // timeline entry (transcript-only — never sent to the model); Ctrl+C stops
  // the run. Like a real shell, a nonzero exit is shown, not treated as an
  // error: the user is the authorizer.
  const runShellMode = async (shellCommand: string): Promise<void> => {
    const entry = recordShellRun(session, shellCommand);
    const keepTail = (text: string): string => (text.length > 48_000 ? text.slice(-48_000) : text);
    const controller = new AbortController();
    shellAbort = controller;
    // Long-running commands animate the header's ellipsis (same gradient
    // frames as the waiting indicator) so a live job is obvious at a glance.
    const animation = setInterval(() => {
      if (closed) { clearInterval(animation); return; }
      // Decoration only: frozen while blurred. A skipped frame leaves the
      // screen untouched, so it must not mark the frame stale.
      if (!windowFocused) return;
      shellAnimationFrame += 1;
      conversationDirty = true;
      scheduleRefresh();
    }, 60);
    animation.unref?.();
    conversationDirty = true;
    refresh();
    try {
      const result = await runShellCommand(shellCommand, {
        workspaceRoot: runtime.workspace(),
        signal: controller.signal,
        onChunk: (text) => {
          const cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
          if (!cleaned) return;
          entry.content = keepTail(entry.content + cleaned);
          conversationDirty = true;
          scheduleRefresh();
        },
      });
      entry.content = keepTail(result.output.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
      entry.exitCode = result.exitCode;
      entry.status = result.exitCode === 0 ? 'completed' : result.exitCode === undefined ? 'cancelled' : 'failed';
      entry.endedAt = Date.now();
    } finally {
      clearInterval(animation);
      if (shellAbort === controller) shellAbort = undefined;
      conversationDirty = true;
      refresh();
    }
  };

  const unsubscribe = runtime.subscribe(onEvent);
  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolveDone) => { finish = resolveDone; });
  function close(): void {
    if (closed) return;
    closed = true;
    stopSpinner();
    stopStreamTimer();
    if (welcomeTimer) clearInterval(welcomeTimer);
    clearInterval(instancePoll);
    unsubscribe();
    // Release bracketed paste mode before the screen goes away so the shell
    // after exit does not keep accumulating pasted text without newlines.
    // Leave the alternate buffer for the same reason: the forced ?1049 entry
    // must not outlive the TUI even where terminfo's rmcup is empty.
    try {
      screen.program.write(BRACKETED_PASTE_DISABLE);
      screen.program.decrst('1004');
      screen.program.decrst('1049');
      screen.program.flush();
    } catch {
      // The program may already be torn down; the reset is best effort.
    }
    screen.destroy();
    // Blessed only removes its own listeners on destroy; release our proxy's
    // forwarding too so the real stdin is left with no lingering listeners.
    try { pasteInput.destroy?.(); } catch {
      // Already torn down; nothing left to release.
    }
    finish?.();
  }

  composer.on('keypress', handleComposerKey);
  completions.on('select', (_item, index: number) => {
    const selected = commandMatches(composerValue())[index];
    if (selected) { setComposerValue(selected.name + ' '); focusComposer(); }
  });
  const runAction = (action: () => Promise<void>): void => {
    void action().catch((error) => { notice = `Error: ${error instanceof Error ? error.message : String(error)}`; refresh(); });
  };
  activity.key(['enter', 'space'], () => { runAction(showActivityDetail); });
  activity.on('select item', (_item, index) => { selectedActivityIndex = index; });
  const openCommandPalette = (): void => {
    if (screen.focused === composer || screen.focused === conversation || screen.focused === activity) runAction(commandPalette);
  };
  const toggleActivity = (): void => {
    activityVisible = !activityVisible;
    requestFullRedraw();
    refresh();
    focusComposer();
  };
  screen.key(['C-k'], openCommandPalette);
  screen.key(['C-b'], toggleActivity);
  // Conversation and activity panes are mouse-scrollable. Focus returns to the
  // composer after generation or when a modal closes.
  /** Rendered (wrapped) conversation row for a logical content line. */
  const renderedConversationRow = (real: number): number => {
    const bucket = (conversation as unknown as { _clines?: { ftor?: Array<unknown[]> } })._clines?.ftor?.[real];
    return bucket && bucket.length > 0 ? Number(bucket[0]) : real;
  };
  const toggleThinkingBlock = (turnId: string): void => {
    const block = thinkingBlocks.get(turnId);
    if (!block) return;
    conversationFollowOutput = false;
    // A block whose header has scrolled above the viewport is toggled through
    // its pinned overlay. That row stays put at the top: restoring the raw
    // scroll offset instead would land somewhere else once the body folds away.
    const pos = thinkingBlockLines.get(turnId);
    const headerRow = pos ? renderedConversationRow(pos.headerLine) : conversation.childBase;
    conversationScrollOffset = headerRow < conversation.childBase ? headerRow : conversation.childBase;
    block.expanded = !block.expanded;
    conversationDirty = true;
    requestFullRedraw();
    refresh();
  };

  const focusConversation = (): void => {
    // Browsing is independent of keyboard focus: typing always goes to the draft.
    focusComposer();
  };

  const setMouseInteraction = (enabled: boolean): void => {
    selection = undefined;
    nativeSelection = !enabled;
    if (nativeSelection) screen.program.disableMouse();
    else {
      screen.program.enableMouse();
      if (process.platform === 'win32' || screen.program.term('windows')) {
        screen.program.setMouse({ vt200Mouse: true, sgrMouse: true, utfMouse: false, cellMotion: true, allMotion: true }, true);
      }
    }
    refresh();
  };
  screen.key(['f2'], () => setMouseInteraction(nativeSelection));

  composer.on('click', focusComposer);

  conversation.on('click', (data: { x: number; y: number }) => {
    if (modalDepth > 0) return;
    if (hasSelection()) return;
    focusConversation();
    if (!data || data.y === undefined) return;
    const lpos = conversation.lpos;
    if (!lpos) return;
    const contentTop = lpos.yi + Number(conversation.itop);
    const relY = data.y - contentTop;
    // A click on the sticky overlay already toggled the block; the bubbled
    // copy must not toggle it back.
    if (stickyClickHandled) {
      stickyClickHandled = false;
      return;
    }
    // The pinned header is an overlay, not an inserted row: logical line
    // indices still map 1:1 onto rendered rows, so no extra offset applies.
    const row = Math.floor(relY) + conversation.childBase;
    // RenderThinkingBlock records indices in the raw `lines` array, but blessed
    // re-parses/wraps content into `_clines`. Translate via ftor so the click
    // still hits the header even when a preceding long line was wrapped.
    for (const [turnId, pos] of thinkingBlockLines) {
      if (row === renderedConversationRow(pos.headerLine)) {
        toggleThinkingBlock(turnId);
        return;
      }
    }
  });
  screen.key(['C-y'], () => {
    if (latestThinkingTurnId) toggleThinkingBlock(latestThinkingTurnId);
  });
  activity.on('click', (data: { y?: number }) => {
    if (modalDepth > 0) return;
    const list = activity as unknown as { items: blessed.Widgets.BlessedElement[]; selected: number };
    const selectedItem = list.items[list.selected];
    const bounds = selectedItem?.lpos;
    if (!bounds || data.y === undefined || data.y < bounds.yi || data.y >= bounds.yl) return;
    selectedActivityIndex = list.selected;
    runAction(showActivityDetail);
  });
  // Blessed routes clicks that land on a rendered list row to the row element
  // itself; the list only sees the bubbled `element click`. Resolve the row
  // back to its agent so a click opens that agent's progress directly.
  activity.on('element click', (el: blessed.Widgets.BlessedElement) => {
    if (modalDepth > 0) return;
    const list = activity as unknown as { items: blessed.Widgets.BlessedElement[] };
    const index = list.items.indexOf(el);
    if (index < 0) return;
    selectedActivityIndex = index;
    runAction(showActivityDetail);
  });
  conversation.on('mousedown', () => { if (modalDepth === 0) focusConversation(); });
  conversation.on('wheelup', () => {
    selection = undefined;
    if (modalDepth === 0) focusConversation();
    conversationFollowOutput = false;
    conversationScrollOffset = conversation.childBase;
    refresh();
  });
  conversation.on('wheeldown', () => {
    selection = undefined;
    if (modalDepth === 0) focusConversation();
    conversationScrollOffset = conversation.childBase;
    conversationFollowOutput = conversationAtBottom();
    refresh();
  });
  conversation.on('scroll', () => {
    if (restoringConversationScroll) return;
    conversationScrollOffset = conversation.childBase;
    conversationFollowOutput = conversationAtBottom();
    // Pure scrolling does not mark the content dirty; the pinned header still
    // needs to appear/disappear as the viewport moves.
    if (stickyHeader || thinkingBlockLines.size > 0) {
      conversationDirty = true;
      scheduleRefresh();
    }
  });
  screen.key(['pageup', 'pagedown'], (_ch, key) => {
    selection = undefined;
    if (!composerPinned && screen.focused !== conversation) return;
    focusConversation();
    conversation.scroll((key.name === 'pageup' ? -1 : 1) * Math.max(1, Number(conversation.height) - 2));
    renderScreen();
  });
  screen.key(['C-x'], () => { void command('/cancel').catch((error) => { notice = String(error); refresh(); }); });
  screen.key(['tab', 'escape'], () => {
    if (screen.focused === conversation || screen.focused === activity) focusComposer();
  });
  const orderedSelection = (): [Point, Point] | undefined => {
    if (!selection || !hasSelection()) return;
    const { start, end } = selection;
    return start.y < end.y || (start.y === end.y && start.x <= end.x) ? [start, end] : [end, start];
  };
  conversation.on('render', () => {
    const range = orderedSelection();
    if (!range || !selection) return;
    const [start, end] = range;
    for (let y = start.y; y <= end.y; y++) {
      const row = screenBuffer.lines[y];
      if (!row) continue;
      const left = y === start.y ? start.x : selection.left;
      const right = y === end.y ? end.x : selection.right - 1;
      for (let x = left; x <= right; x++) {
        const cell = row[x];
        if (cell) cell[0] = (cell[0] & ~0x3ffff) | (0 << 9) | 6;
      }
      row.dirty = true;
    }
  });
  // Handle the raw protocol before Blessed: SGR drag reports (button 32) are
  // misclassified as repeated presses by Blessed 0.1.x on some terminals.
  screen.program.prependListener('mouse', (data: { action: string; button?: string; x: number; y: number; raw?: unknown[] }) => {
    if (nativeSelection) return;
    const bounds = conversation.lpos;
    if (!bounds) return;
    const rawButton = Number(data.raw?.[0]);
    const motion = data.action === 'mousemove' || (Number.isFinite(rawButton) && (rawButton & 32) !== 0 && (rawButton & 64) === 0);
    if (motion && selection?.dragging) {
      data.action = 'mousemove';
      selection.end = { x: Math.max(selection.left, Math.min(selection.right - 1, data.x)), y: Math.max(selection.top, Math.min(selection.bottom - 1, data.y)) };
      renderScreen();
    } else if (data.action === 'mousedown' && data.button === 'left'
      && data.x >= bounds.xi + Number(conversation.ileft) && data.x < bounds.xl - (Number(conversation.iwidth) - Number(conversation.ileft)) - 1
      && data.y >= bounds.yi && data.y < bounds.yl) {
      selection = {
        start: { x: data.x, y: data.y }, end: { x: data.x, y: data.y }, dragging: true,
        rows: screenBuffer.lines.map((row) => row.map((cell) => cell[1])),
        left: bounds.xi + Number(conversation.ileft), right: bounds.xl - (Number(conversation.iwidth) - Number(conversation.ileft)) - 1,
        top: bounds.yi, bottom: bounds.yl,
      };
    } else if (data.action === 'mouseup' && selection?.dragging) {
      selection.dragging = false;
    }
  });
  // Ctrl+C semantics depend on mode: inside a /btw side conversation it
  // returns to the parent session; elsewhere a bare press arms a quit
  // confirmation and a second press within 2s exits, so a stray Ctrl+C never
  // kills the session by accident.
  let ctrlCAt = 0;
  const handleBareCtrlC = (): void => {
    // A running !command is the first thing Ctrl+C stops; the quit
    // confirmation must not fire while the user is just killing a job.
    if (shellAbort) { shellAbort.abort(); notice = 'Stopping command…'; refresh(); return; }
    if (isBtw()) {
      const parent = sideParentSessionId!;
      void switchSession(parent).then(() => {
        notice = 'Returned from /btw side conversation.';
        refresh();
      });
      return;
    }
    // A non-empty draft changes the first press: park it in history and
    // clear the composer. The second press (or a bare press on an empty
    // composer) arms the quit as before.
    if (composerValue().trim()) {
      const draft = composerValue().trim();
      if (inputHistory[inputHistory.length - 1] !== draft) inputHistory.push(draft);
      // setComposerValue resets historyIndex, so the next Up naturally lands
      // on the freshly parked draft.
      setComposerValue('');
      notice = 'Draft saved — press Up to restore.';
      // The notice renders through the conversation timeline; without this
      // flag the repaint skips the stale transcript and the user never sees
      // the confirmation.
      conversationDirty = true;
      renderComposerFrame();
      refresh();
      focusComposer();
      return;
    }
    const pressedAt = Date.now();
    if (pressedAt - ctrlCAt > 2000) {
      ctrlCAt = pressedAt;
      notice = 'Press Ctrl+C again to quit.';
      refresh();
      return;
    }
    close();
  };
  screen.key(['C-c'], () => {
    const range = orderedSelection();
    if (!range || !selection) { handleBareCtrlC(); return; }
    const [start, end] = range;
    const lines: string[] = [];
    for (let y = start.y; y <= end.y; y++) {
      const left = y === start.y ? start.x : selection.left;
      const right = y === end.y ? end.x + 1 : selection.right;
      lines.push((selection.rows[y] ?? []).slice(left, right).join('').replace(/[\x00\x03]/g, '').trimEnd());
    }
    runAction(async () => {
      try { await (options.copyToClipboard ?? copyText)(lines.join('\n')); }
      finally { selection = undefined; }
      refresh();
      focusComposer();
    });
  });
  composer.on('keypress', (_ch, key: { name?: string; ctrl?: boolean }) => {
    if (hasSelection() && !(key.ctrl && key.name === 'c')) { selection = undefined; refresh(); }
  });
  screen.key(['escape'], () => { selection = undefined; refresh(); });
  screen.on('resize', refresh);

  refresh();
  focusComposer();
  await done;
}
