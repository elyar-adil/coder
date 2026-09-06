import blessed from 'blessed';

import type { BackendConfig } from '../backend.js';
import type { AgentConfig, AgentModelConfig } from '../config.js';
import type { AgentEvent, AgentInstance, AgentSession } from '../domain/agent.js';
import { renderTuiMarkdown, toolDiff } from './markdown.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import { layoutComposer } from './composer-layout.js';
import { renderWelcome } from './welcome.js';
import { copyText } from './clipboard.js';
import { commandMatches } from './commands.js';

type ResolvedModel = { name: string; config: BackendConfig };
type Provider = {
  id: 'openai' | 'openrouter' | 'anthropic' | 'ollama' | 'custom';
  label: string;
  backend: AgentModelConfig['backend'];
  baseUrl: string;
  needsKey: boolean;
};

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

const PROVIDERS: Provider[] = [
  { id: 'openai', label: 'OpenAI', backend: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { id: 'openrouter', label: 'OpenRouter', backend: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true },
  { id: 'anthropic', label: 'Anthropic', backend: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true },
  { id: 'ollama', label: 'Ollama · local', backend: 'ollama', baseUrl: 'http://localhost:11434', needsKey: false },
  { id: 'custom', label: 'Custom · OpenAI compatible', backend: 'openai', baseUrl: '', needsKey: false },
];

const COLOR = {
  // Stick to the ANSI palette so Windows consoles do not quantize custom RGB
  // values into black. In blessed, `gray` is bright-black (color 8), so it can
  // disappear on a black background; `white` is the readable 8-color fallback.
  background: 'black', panel: 'black', elevated: 'black', line: 'gray',
  text: 'light-white', muted: 'white', accent: 'light-cyan', green: 'light-green',
  amber: 'light-yellow', red: 'light-red', violet: 'light-magenta',
};

const STATUS: Record<string, { icon: string; color: string }> = {
  queued: { icon: '○', color: COLOR.muted }, running: { icon: '●', color: COLOR.accent },
  idle: { icon: '✓', color: COLOR.green }, waiting: { icon: '◌', color: COLOR.amber },
  failed: { icon: '!', color: COLOR.red }, cancelled: { icon: '×', color: COLOR.muted },
};

function oneLine(value: string | undefined, max = 72): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safe(value: string): string {
  return blessed.escape(value);
}

function providerName(config: AgentModelConfig): string {
  if (config.backend === 'anthropic') return 'Anthropic';
  if (config.backend === 'ollama') return 'Ollama';
  if (config.baseUrl?.includes('openrouter.ai')) return 'OpenRouter';
  return 'OpenAI compatible';
}

export async function runFullscreenTui(runtime: AgentRuntime, options: FullscreenTuiOptions): Promise<void> {
  let sessionId = `session-${Date.now()}`;
  let session = await runtime.openSession(sessionId);
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
  }
  const thinkingBlocks = new Map<string, ThinkingBlock>();
  const thinkingBlockLines = new Map<string, { headerLine: number }>();
  let latestThinkingTurnId: string | undefined;
  let conversationFollowOutput = true;
  let conversationScrollOffset = 0;
  let restoringConversationScroll = false;
  let composerRow = 0;
  let composerColumn = 0;
  let notice = '';
  let completionIndex = 0;
  let completionQuery = '';
  let dismissedCompletion = '';
  let nativeSelection = false;
  type Point = { x: number; y: number };
  let selection: { start: Point; end: Point; rows: string[][]; left: number; right: number; top: number; bottom: number; dragging: boolean } | undefined;
  const hasSelection = (): boolean => Boolean(selection && (selection.start.x !== selection.end.x || selection.start.y !== selection.end.y));

  const screen = blessed.screen({
    smartCSR: true, fullUnicode: true, title: 'Coder',
    style: { bg: COLOR.background, fg: COLOR.text },
  });
  const screenBuffer = screen as unknown as { lines: Array<Array<[number, string]> & { dirty: boolean }> };

  const statusbar = blessed.box({
    parent: screen, bottom: 0, left: 0, width: '100%', height: 1, tags: true,
    padding: { left: 1, right: 1 }, style: { bg: COLOR.background, fg: COLOR.muted },
  });
  const conversation = blessed.box({
    parent: screen, top: 0, left: 0, width: '100%', bottom: 3,
    tags: true, scrollable: true, alwaysScroll: true, keys: true, vi: true, mouse: true, autoFocus: false,
    scrollbar: {
      ch: '│',
      track: { bg: COLOR.panel },
      style: { fg: COLOR.muted },
    },
    padding: { left: 2, right: 2 },
    style: { bg: COLOR.background, fg: COLOR.text },
  });
  const activity = blessed.list({
    parent: screen, top: 0, right: 0, width: '28%', bottom: 2,
    tags: true, keys: true, vi: true, mouse: true,
    scrollable: true, padding: { left: 1, right: 1 },
    style: {
      bg: COLOR.background, fg: COLOR.muted,
      selected: { bg: COLOR.elevated, fg: COLOR.accent, bold: true },
    },
  });
  const composer = blessed.box({
    parent: screen, bottom: 1, left: 3, width: '100%-4', height: 2,
    input: true, keys: true, mouse: true, padding: { left: 0, right: 1 },
    style: { bg: COLOR.background, fg: COLOR.text },
  });
  const divider = blessed.box({
    parent: screen, bottom: 3, left: 1, width: '100%-2', height: 1,
    style: { fg: COLOR.line, bg: COLOR.background },
  });
  const composerPrompt = blessed.box({
    parent: screen, bottom: 1, left: 1, width: 2, height: 2,
    content: '›', style: { bg: COLOR.background, fg: COLOR.accent },
  });
  const completions = blessed.list({
    parent: screen, left: 2, bottom: 4, width: '100%-4', height: 5,
    hidden: true, tags: true, mouse: true, keys: false, autoFocus: false,
    style: { bg: COLOR.panel, fg: COLOR.muted, selected: { fg: COLOR.accent, bold: true } },
  });

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
    composer.height = height;
    composerPrompt.height = height;
    conversation.bottom = height + 2;
    activity.bottom = height + 2;
    divider.bottom = height + 1;
    divider.setContent('─'.repeat(Math.max(0, Number(screen.width) - 2)));
    composerRow = result.cursor.row - start;
    composerColumn = result.cursor.column;
    composer.setContent(result.rows.slice(start, start + height).join('\n'));
    const query = composerValue();
    if (query !== completionQuery) { completionIndex = 0; completionQuery = query; }
    const matches = query === dismissedCompletion ? [] : commandMatches(query);
    if (!matches.length) completions.hide();
    else {
      completions.bottom = height + 2;
      completions.height = Math.min(matches.length, 6, Math.max(1, Number(screen.height) - height - 3));
      completionIndex = Math.min(completionIndex, matches.length - 1);
      completions.setItems(matches.map((item) => `${item.name.padEnd(12)} ${item.description}`));
      completions.select(completionIndex);
      completions.show();
      completions.setFront();
    }
  };

  const renderComposerFrame = (): void => {
    renderComposer();
    screen.program.hideCursor();
    screen.render();
    placeComposerCursor();
    screen.program.showCursor();
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

  const handleComposerKey = (ch: string, key: { name?: string; ctrl?: boolean; meta?: boolean }): void => {
    if (closed) return;
    const matches = completions.hidden ? [] : commandMatches(composerValue());
    if (matches.length && (key.name === 'up' || key.name === 'down')) {
      completionIndex = (completionIndex + (key.name === 'up' ? -1 : 1) + matches.length) % matches.length;
      renderComposerFrame(); return;
    }
    if (matches.length && key.name === 'escape') {
      dismissedCompletion = composerValue(); renderComposerFrame(); return;
    }
    if (matches.length && (key.name === 'tab' || ((!key.meta) && (key.name === 'enter' || key.name === 'return')))) {
      setComposerValue(matches[completionIndex]!.name + (key.name === 'tab' ? ' ' : ''));
      if (key.name === 'tab') renderComposerFrame(); else void submit();
      return;
    }
    if ((key.name === 'enter' || key.name === 'return') && !key.meta) { void submit(); return; }
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

  const startSpinner = (): void => {
    if (spinnerTimer || pendingTurns.size === 0) return;
    spinnerTimer = setInterval(() => {
      if (pendingTurns.size === 0 || closed) {
        stopSpinner();
        return;
      }
      if (nativeSelection || hasSelection()) return;
      spinnerFrame = (spinnerFrame + 1) % 20;
      refresh();
    }, 120);
    spinnerTimer.unref?.();
  };

  const stopSpinner = (): void => {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  };

  const focusComposer = (): void => {
    if (closed) return;
    composerPinned = true;
    if (screen.focused !== composer) composer.focus();
    renderComposerFrame();
  };

  const choose = (title: string, items: string[]): Promise<number> => new Promise((resolveChoice) => {
    composerPinned = false;
      const width = Math.min(Number(screen.width), 88, Math.max(32, ...items.map((item) => item.length + 8)));
    const modal = blessed.box({
      parent: screen, top: 'center', left: 'center', width, height: Math.min(items.length + 4, 22, Number(screen.height)),
      label: ` ${title} `, border: { type: 'line' },
      style: { bg: COLOR.background, fg: COLOR.text, border: { fg: COLOR.line }, label: { fg: COLOR.accent } },
    });
    const list = blessed.list({
      parent: modal, top: 1, left: 1, right: 1, bottom: 1, items, keys: true, vi: true, mouse: true,
      scrollable: true, style: { bg: COLOR.background, fg: COLOR.text, selected: { bg: COLOR.elevated, fg: COLOR.text, bold: true } },
    });
    let done = false;
    const finish = (value: number): void => {
      if (done) return;
      done = true;
      modal.destroy();
      composerPinned = true;
      focusComposer();
      resolveChoice(value);
    };
    list.on('select', (_item, index) => finish(index));
    list.key(['escape', 'q'], () => finish(-1));
    list.focus();
    screen.render();
  });

  const ask = (label: string, initial = '', secret = false): Promise<string> => new Promise((resolveAnswer) => {
    composerPinned = false;
    const prompt = blessed.prompt({
      parent: screen, top: 'center', left: 'center', width: '72%', height: 7,
      label: ` ${label} `, border: { type: 'line' },
      style: { bg: COLOR.background, fg: COLOR.text, border: { fg: COLOR.line }, label: { fg: COLOR.accent } },
    });
    if (secret) (prompt as unknown as { _: { input: { censor: boolean } } })._.input.censor = true;
    prompt.input(label, initial, (_error, value) => {
      prompt.destroy();
      composerPinned = true;
      focusComposer();
      resolveAnswer(String(value ?? '').trim());
    });
  });

  const instances = (): AgentInstance[] => runtime.listInstances(sessionId);

  const depthPrefix = (instance: AgentInstance): string => {
    const status = STATUS[instance.status] ?? STATUS.idle!;
    return `${'  '.repeat(instance.depth)}{${status.color}-fg}${status.icon}{/${status.color}-fg}`;
  };

  const renderStatus = (): void => {
    const active = instances().filter((item) => item.status === 'running' || item.status === 'waiting' || item.status === 'queued').length;
    const activityText = active ? ` · ${active} active` : '';
    const width = Math.max(1, Number(screen.width) - 2);
    const left = `coder · ${activeModel}`;
    const right = `${sessionId}${activityText}`;
    const gap = width - Number(statusbar.strWidth(left)) - Number(statusbar.strWidth(right));
    statusbar.setContent(gap >= 3
      ? `{${COLOR.accent}-fg}coder{/${COLOR.accent}-fg} · ${safe(activeModel)}${' '.repeat(gap)}${safe(right)}`
      : `{${COLOR.accent}-fg}coder{/${COLOR.accent}-fg} · ${safe(activeModel)}${activityText}`);
  };

  const conversationAtBottom = (): boolean => {
    const viewportHeight = Math.max(0, Number(conversation.height) - Number(conversation.iheight));
    const scrollHeight = conversation.getScrollHeight();
    if (scrollHeight <= viewportHeight) return true;
    return conversation.childBase >= scrollHeight - viewportHeight - 1;
  };

  const renderConversation = (): void => {
    session = runtime.getSession(sessionId) ?? session;
    for (const message of session.messages) {
      if (message.thinking && message.turnId && !thinkingBlocks.has(message.turnId)) {
        const thinking = session.messages.filter((item) => item.turnId === message.turnId).map((item) => item.thinking ?? '').join('');
        thinkingBlocks.set(message.turnId, { turnId: message.turnId, expanded: false, content: [], status: 'completed', thinking });
      }
    }
    const previousScrollOffset = conversationScrollOffset;
    const shouldFollowOutput = conversationFollowOutput;
    const lines: string[] = [];
    const screenWidth = typeof screen.width === 'number' ? screen.width : 80;
    const markdownCols = Math.max(10, Math.min(120, screenWidth - (activityVisible ? Math.min(36, Math.floor(screenWidth * 0.35)) : 0) - 6));
    thinkingBlockLines.clear();
    const welcomeVisible = !session.messages.length && !streams.size && thinkingBlocks.size === 0;
    if (welcomeVisible) {
      lines.push(...renderWelcome(
        Number(conversation.width) - Number(conversation.iwidth) - 1,
        Number(conversation.height) - Number(conversation.iheight), Number(screen.height), welcomeFrame,
      ));
      if (!welcomeTimer) {
        welcomeTimer = setInterval(() => {
          if (nativeSelection || hasSelection() || screen.focused !== composer) return;
          welcomeFrame = (welcomeFrame + 1) % 80;
          refresh();
        }, 50);
        welcomeTimer.unref?.();
      }
    } else if (welcomeTimer) {
      clearInterval(welcomeTimer);
      welcomeTimer = undefined;
    }
    const renderedBlocks = new Set<string>();
    if (session.timeline) {
      for (const entry of session.timeline) {
        if (entry.kind === 'message') {
          lines.push('', entry.role === 'user' ? `{${COLOR.accent}-fg}›{/${COLOR.accent}-fg} ${safe(entry.content)}` : renderTuiMarkdown(entry.content, markdownCols), '');
          continue;
        }
        const expanded = thinkingBlocks.get(entry.id)?.expanded ?? false;
        const block: ThinkingBlock = { turnId: entry.id, expanded, content: [],
          status: entry.status === 'running' ? 'active' : 'completed',
          thinking: entry.kind === 'thinking' ? entry.content : undefined };
        thinkingBlocks.set(entry.id, block);
        if (entry.kind === 'thinking') {
          renderThinkingBlock(lines, block);
        } else {
          const headerLine = lines.reduce((count, line) => count + line.split('\n').length, 0);
          thinkingBlockLines.set(entry.id, { headerLine });
          latestThinkingTurnId = entry.id;
          const agent = entry.instanceId ? runtime.getInstance(entry.instanceId)?.agentId : undefined;
          const icon = entry.status === 'running' ? '◌' : entry.status === 'failed' ? '✗' : entry.status === 'cancelled' ? '−' : '✓';
          const color = entry.status === 'failed' ? COLOR.amber : COLOR.muted;
          lines.push(`{${color}-fg}${expanded ? '▼' : '▶'} ${icon} ${safe(agent && agent !== 'main' ? `${agent} · ` : '')}${safe(entry.tool ?? '')}  ${safe(oneLine(entry.input, Math.max(20, markdownCols - 30)))}{/${color}-fg}`);
          if (expanded) {
            lines.push(safe(entry.input ?? ''), renderTuiMarkdown(entry.content || 'Running…', markdownCols));
          } else {
            const patch = toolDiff(entry.tool ?? '', entry.content);
            if (patch) lines.push(renderTuiMarkdown(patch, markdownCols));
            if (entry.status === 'failed') lines.push(`{${COLOR.amber}-fg}${safe(oneLine(entry.content, markdownCols))}{/${COLOR.amber}-fg}`);
          }
          lines.push('');
        }
      }
    }
    for (const message of session.timeline ? [] : session.messages) {
      const user = message.role === 'user';
      const prefix = user
        ? `{${COLOR.accent}-fg}›{/${COLOR.accent}-fg} `
        : message.role === 'system'
          ? `{${COLOR.amber}-fg}·{/${COLOR.amber}-fg} `
          : '';
      const content = message.role === 'assistant'
        ? renderTuiMarkdown(message.content, markdownCols)
        : safe(message.content);
      lines.push('', `${prefix}${content}`, '');
      if (message.role === 'user' && message.turnId && thinkingBlocks.has(message.turnId)) {
        renderedBlocks.add(message.turnId);
        renderThinkingBlock(lines, thinkingBlocks.get(message.turnId)!);
      }
    }
    if (!session.timeline && pendingTurns.size > 0) {
      const turnId = [...pendingTurns][0];
      if (!thinkingBlocks.has(turnId)) {
        thinkingBlocks.set(turnId, { turnId, expanded: false, content: [], status: 'active' });
      }
      if (!renderedBlocks.has(turnId)) {
        renderThinkingBlock(lines, thinkingBlocks.get(turnId)!);
      }
    }
    for (const [turnId, text] of session.timeline ? [] : streams.entries()) {
      if (!text.trim()) continue;
      lines.push('', `{${COLOR.muted}-fg}…{/${COLOR.muted}-fg}`, renderTuiMarkdown(text, markdownCols), '');
    }
    if (notice) lines.push('', `{${COLOR.amber}-fg}${safe(notice)}{/${COLOR.amber}-fg}`, '');
    restoringConversationScroll = true;
    try {
      conversation.setContent(lines.join('\n'));
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
    conversationFollowOutput = shouldFollowOutput;
  };

  const renderThinkingBlock = (lines: string[], block: ThinkingBlock): void => {
    // Array entries can contain multiple source lines (messages and Markdown).
    const headerLine = lines.reduce((count, line) => count + line.split('\n').length, 0);
    const toggle = block.expanded ? '▼' : '▶';
    const icon = block.status === 'active'
      ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][spinnerFrame % 10]
      : toggle;
    const color = block.status === 'active' ? COLOR.accent : COLOR.green;
    const label = block.thinking
      ? (block.status === 'active' ? 'Thinking' : 'Thought')
      : (block.status === 'active' ? 'Working' : 'Activity');
    if (block.status === 'active') {
      const scanLabel = `{${COLOR.accent}-fg}${label}{/${COLOR.accent}-fg}`;
      lines.push(`{${color}-fg}${toggle} ${icon}{/${color}-fg} ${scanLabel}`);
    } else {
      lines.push(`{${color}-fg}${icon} ${label}{/${color}-fg}`);
    }
    thinkingBlockLines.set(block.turnId, { headerLine });
    latestThinkingTurnId = block.turnId;
    if (block.expanded) {
      if (block.thinking) lines.push(...safe(block.thinking).split('\n').map((line) => `  ${line}`), '');
      const content = block.content.length > 0 ? block.content : block.thinking ? [] : ['No thinking or tool activity received yet.'];
      for (const c of content) {
        const rendered = c.includes('```diff\n')
          ? renderTuiMarkdown(c, Math.max(10, Number(conversation.width) - 8))
          : safe(c);
        lines.push(...rendered.split('\n').map((line) => `  ${line}`));
      }
    }
    lines.push('');
  };

  const renderActivity = (): void => {
    const current = instances();
    activity.setItems(current.map((instance) => {
      const model = runtime.registry.get(instance.agentId)?.model;
      return `${depthPrefix(instance)} {bold}${safe(instance.agentId)}{/bold}  {${COLOR.muted}-fg}${instance.status}${model ? ` · ${safe(model)}` : ''}{/${COLOR.muted}-fg}\n${'  '.repeat(instance.depth + 1)}${safe(oneLine(instance.lastOutput || instance.lastError || activityLog.get(instance.instanceId)?.at(-1), 36))}`;
    }));
  };

  const layout = (): void => {
    if (activityVisible) {
      activity.show();
      const width = Math.min(36, Math.floor(Number(screen.width) * 0.35));
      activity.width = width;
      conversation.width = Number(screen.width) - width;
    } else {
      activity.hide();
      conversation.width = '100%';
      composer.width = '100%-4';
      composerPrompt.left = 1;
    }
    composer.width = '100%-4';
    composerPrompt.left = 1;
  };

  const refresh = (): void => {
    if (closed) return;
    if (hasSelection()) return;
    layout();
    renderComposer();
    renderStatus();
    renderConversation();
    renderActivity();
    renderComposer();
    const composerFocused = composerPinned;
    if (composerFocused && screen.focused !== composer) composer.focus();
    if (composerFocused) screen.program.hideCursor();
    screen.render();
    if (composerFocused) {
      placeComposerCursor();
      screen.program.showCursor();
    }
  };

  const applyModel = async (alias: string): Promise<void> => {
    const resolved = options.resolveModel(alias);
    if (!resolved.config.model) throw new Error('Selected model is not configured.');
    await options.persistModelSelection?.(alias);
    runtime.setDefaultModel(alias);
    await runtime.setSessionDefaultModel(sessionId, alias);
    activeModel = resolved.name;
    refresh();
  };

  const openModel = async (): Promise<void> => {
    const config = options.configManager.getConfig();
    const aliases = [...new Set([...(config.model ? [config.model] : []), ...Object.keys(config.models ?? {}), ...(options.modelAliases ?? [])])];
    if (!aliases.length) { await openProvider(); return; }
    const index = await choose('Model', aliases.map((alias) => {
      const entry = config.models?.[alias];
      return `${alias}${entry ? `  ·  ${providerName(entry)}  ·  ${entry.model}` : ''}${alias === activeModel ? '  ✓' : ''}`;
    }));
    if (index >= 0) await applyModel(aliases[index]!);
  };

  const addProvider = async (): Promise<void> => {
    const providerIndex = await choose('Add provider', PROVIDERS.map((provider) => provider.label));
    if (providerIndex < 0) return;
    const provider = PROVIDERS[providerIndex]!;
    const baseUrl = await ask('Base URL', provider.baseUrl);
    if (!baseUrl) return;
    let apiKey: string | undefined;
    if (provider.needsKey) {
      const envName = provider.id === 'openrouter' ? 'OPENROUTER_API_KEY' : provider.id === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
      apiKey = await ask(`API key · blank uses ${envName}`, '', true) || process.env[envName];
      if (!apiKey) return;
    } else if (provider.id === 'custom') {
      apiKey = await ask('API key · optional', '', true) || undefined;
    }
    const model = await ask('Provider model name');
    if (!model) return;
    const suggested = provider.id === 'openrouter' ? model.split('/').at(-1)! : model.split(':')[0]!;
    const alias = await ask('Local alias', suggested);
    if (!alias) return;
    const contextRaw = await ask('Context window · optional');
    const contextWindow = Number.parseInt(contextRaw, 10);
    const current = options.configManager.getConfig();
    if (current.models?.[alias] && await choose(`Replace ${alias}?`, ['Replace', 'Cancel']) !== 0) return;
    const next: AgentConfig = {
      ...current,
      model: current.model || alias,
      models: {
        ...(current.models ?? {}),
        [alias]: {
          model, baseUrl, backend: provider.backend,
          ...(apiKey ? { apiKey } : {}),
          ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
        },
      },
    };
    await options.configManager.saveConfig(next);
    if (!current.model) await applyModel(alias);
  };

  const removeProvider = async (): Promise<void> => {
    const current = options.configManager.getConfig();
    const entries = Object.entries(current.models ?? {});
    if (!entries.length) return;
    const index = await choose('Remove provider', entries.map(([alias, config]) => `${alias}  ·  ${providerName(config)}  ·  ${config.model}`));
    if (index < 0) return;
    const alias = entries[index]![0];
    if (await choose(`Remove ${alias}?`, ['Remove', 'Cancel']) !== 0) return;
    const models = { ...(current.models ?? {}) };
    delete models[alias];
    const model = current.model === alias ? Object.keys(models)[0] : current.model;
    await options.configManager.saveConfig({ ...current, model, models });
    if (activeModel === alias && model) await applyModel(model);
  };

  const openProvider = async (): Promise<void> => {
    const entries = Object.entries(options.configManager.getConfig().models ?? {});
    const actions = [
      ...entries.map(([alias, config]) => ({ label: `${alias}  ·  ${providerName(config)}  ·  ${config.model}${alias === activeModel ? '  ✓' : ''}`, action: 'select', alias })),
      { label: '+  Add provider', action: 'add', alias: '' },
      ...(entries.length ? [{ label: '−  Remove provider', action: 'remove', alias: '' }] : []),
    ];
    const index = await choose('Provider', actions.map((item) => item.label));
    if (index < 0) return;
    const selected = actions[index]!;
    if (selected.action === 'select') await applyModel(selected.alias);
    else if (selected.action === 'add') await addProvider();
    else await removeProvider();
  };

  const showAgents = async (): Promise<void> => {
    const specs = runtime.listAgentSpecs();
    const index = await choose('Agent specs', specs.map((spec) => `${spec.id}  ·  ${spec.scope}  ·  ${spec.model ?? 'inherit'}  ·  ${oneLine(spec.description, 42)}`));
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

  const switchSession = async (id: string): Promise<void> => {
    const next = await runtime.openSession(id);
    sessionId = id;
    session = next;
    activeModel = session.defaultModel ?? options.modelName;
    streams.clear();
    activityLog.clear();
    thinkingBlocks.clear();
    thinkingBlockLines.clear();
    pendingTurns.clear();
    notice = '';
    conversationFollowOutput = true;
    conversationScrollOffset = 0;
    for (const instance of instances()) {
      if (instance.instanceId === session.mainInstanceId && instance.activeTurnId) pendingTurns.add(instance.activeTurnId);
    }
    startSpinner();
    refresh();
  };

  const openSessions = async (): Promise<void> => {
    const sessions = await runtime.listSessions();
    const index = await choose('Sessions', [...sessions.map((item) => `${item.sessionId}  ·  ${item.messages} messages`), '+  New session']);
    if (index < 0) return;
    await switchSession(index === sessions.length ? `session-${Date.now()}` : sessions[index]!.sessionId);
  };

  const showActivityDetail = async (): Promise<void> => {
    const instance = instances()[selectedActivityIndex];
    if (!instance) return;
    const log = activityLog.get(instance.instanceId) ?? [];
    await choose(`${instance.agentId} · ${instance.instanceId.slice(0, 8)}`, [
      `status  ${instance.status}`,
      `source  ${runtime.registry.get(instance.agentId)?.source ?? ''}`,
      ...log.slice(-12),
      ...(instance.lastOutput ? [`output  ${oneLine(instance.lastOutput, 120)}`] : []),
      ...(instance.lastError ? [`error   ${oneLine(instance.lastError, 120)}`] : []),
      'Close',
    ]);
  };

  const command = async (raw: string): Promise<void> => {
    const [name = '', ...args] = raw.slice(1).trim().split(/\s+/);
    switch (name.toLowerCase()) {
      case 'provider': await openProvider(); break;
      case 'model': await openModel(); break;
      case 'agents': await showAgents(); break;
      case 'sessions': await openSessions(); break;
      case 'new': await switchSession(`session-${Date.now()}`); break;
      case 'clear':
        await runtime.clearSession(sessionId);
        streams.clear();
        thinkingBlocks.clear();
        thinkingBlockLines.clear();
        pendingTurns.clear();
        notice = '';
        refresh();
        break;
      case 'cancel': {
        if (!args[0]) { await runtime.cancelSession(sessionId); notice = 'Stopped. Send a message to continue.'; refresh(); break; }
        const target = instances().find((item) => item.instanceId === args[0] || item.instanceId.startsWith(args[0] ?? ''));
        const main = runtime.getInstance(session.mainInstanceId);
        if (target && main && target.instanceId !== main.instanceId) await runtime.cancelAgent(main.instanceId, target.instanceId);
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
    const actions = ['Provider', 'Model', 'Agent specs', 'Sessions', 'New session', 'Clear conversation', 'Toggle activity', 'Exit'];
    const index = await choose('Command palette', actions);
    if (index === 0) await openProvider();
    if (index === 1) await openModel();
    if (index === 2) await showAgents();
    if (index === 3) await openSessions();
    if (index === 4) await switchSession(`session-${Date.now()}`);
    if (index === 5) await command('/clear');
    if (index === 6) { activityVisible = !activityVisible; refresh(); }
    if (index === 7) close();
  };

  const submit = async (): Promise<void> => {
    const value = composerValue().trim();
    if (!value) { focusComposer(); return; }
    if (!inputHistory.includes(value)) inputHistory.push(value);
    setComposerValue('');
    focusComposer();
    try {
      if (value.startsWith('/')) await command(value);
      else {
        notice = '';
        conversationFollowOutput = true;
        const turnId = await runtime.submitMessage(sessionId, value);
        const main = runtime.getInstance(session.mainInstanceId);
        if (main && ['running', 'queued', 'waiting'].includes(main.status)) pendingTurns.add(turnId);
        if (pendingTurns.has(turnId) && !thinkingBlocks.has(turnId)) {
          thinkingBlocks.set(turnId, { turnId, expanded: false, content: [], status: 'active' });
        }
        startSpinner();
        refresh();
      }
    } catch (error) {
      await choose('Error', [error instanceof Error ? error.message : String(error), 'Close']);
    }
    refresh();
    focusComposer();
  };

  const onEvent = (event: AgentEvent): void => {
    const eventSession = 'sessionId' in event ? event.sessionId : 'instance' in event ? event.instance.sessionId : 'instanceId' in event && event.instanceId ? runtime.getInstance(event.instanceId)?.sessionId : event.type === 'session_opened' ? event.session.sessionId : undefined;
    if (eventSession && eventSession !== sessionId) return;
    if (event.type === 'thinking_delta') {
      const block = thinkingBlocks.get(event.turnId) ?? [...thinkingBlocks.values()].reverse().find((item) => item.status === 'active') ?? thinkingBlocks.get(latestThinkingTurnId ?? '');
      if (block) block.thinking = `${block.thinking ?? ''}${event.text}`;
    }
    if (event.type === 'assistant_delta') streams.set(event.turnId, `${streams.get(event.turnId) ?? ''}${event.text}`);
    if (event.type === 'assistant_message') {
      streams.delete(event.message.turnId ?? '');
    }
    if (event.type === 'tool_started' || event.type === 'tool_finished') {
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
    if (event.type === 'runtime_error') {
      if (event.sessionId === sessionId && event.instanceId === session.mainInstanceId) {
        notice = `Error: ${event.error}`;
        pendingTurns.clear();
        stopSpinner();
      }
    }
    if (event.type === 'instance_updated' && event.instance.instanceId === session.mainInstanceId
      && event.instance.activeTurnId && ['running', 'waiting'].includes(event.instance.status)) {
      const turnId = event.instance.activeTurnId;
      pendingTurns.clear();
      pendingTurns.add(turnId);
      for (const [id, block] of thinkingBlocks) {
        if (id !== turnId) { block.status = 'completed'; streams.delete(id); }
      }
      if (!thinkingBlocks.has(turnId)) thinkingBlocks.set(turnId, { turnId, expanded: false, content: [], status: 'active' });
      startSpinner();
    }
    if (event.type === 'instance_updated'
      && event.instance.sessionId === sessionId
      && event.instance.instanceId === session.mainInstanceId
      && ['idle', 'failed', 'cancelled'].includes(event.instance.status)) {
      const block = [...thinkingBlocks.values()].find(b => b.status === 'active');
      if (block) {
        block.status = 'completed';
      }
      pendingTurns.clear();
      streams.clear();
      stopSpinner();
    }
    refresh();
  };

  const unsubscribe = runtime.subscribe(onEvent);
  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolveDone) => { finish = resolveDone; });
  function close(): void {
    if (closed) return;
    closed = true;
    stopSpinner();
    if (welcomeTimer) clearInterval(welcomeTimer);
    unsubscribe();
    screen.destroy();
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
    refresh();
    focusComposer();
  };
  screen.key(['C-k'], openCommandPalette);
  screen.key(['C-b'], toggleActivity);
  // Conversation and activity panes are mouse-scrollable. Focus returns to the
  // composer after generation or when a modal closes.
  const toggleThinkingBlock = (turnId: string): void => {
    const block = thinkingBlocks.get(turnId);
    if (!block) return;
    conversationFollowOutput = false;
    conversationScrollOffset = conversation.childBase;
    block.expanded = !block.expanded;
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
    if (hasSelection()) return;
    focusConversation();
    if (!data || data.y === undefined) return;
    const lpos = conversation.lpos;
    if (!lpos) return;
    const contentTop = lpos.yi + Number(conversation.itop);
    const relY = data.y - contentTop;
    const row = Math.floor(relY) + conversation.childBase;
    // RenderThinkingBlock records indices in the raw `lines` array, but blessed
    // re-parses/wraps content into `_clines`. Translate via ftor so the click
    // still hits the header even when a preceding long line was wrapped.
    const clines = (conversation as unknown as { _clines?: { ftor?: Array<unknown[]> } })._clines;
    const renderedLine = (real: number): number => {
      const bucket = clines?.ftor?.[real];
      return bucket && bucket.length > 0 ? Number(bucket[0]) : real;
    };
    for (const [turnId, pos] of thinkingBlockLines) {
      if (row === renderedLine(pos.headerLine)) {
        toggleThinkingBlock(turnId);
        return;
      }
    }
  });
  screen.key(['C-y'], () => {
    if (latestThinkingTurnId) toggleThinkingBlock(latestThinkingTurnId);
  });
  activity.on('click', focusComposer);
  conversation.on('mousedown', focusConversation);
  conversation.on('wheelup', () => {
    selection = undefined;
    focusConversation();
    conversationFollowOutput = false;
    conversationScrollOffset = conversation.childBase;
    refresh();
  });
  conversation.on('wheeldown', () => {
    selection = undefined;
    focusConversation();
    conversationScrollOffset = conversation.childBase;
    conversationFollowOutput = conversationAtBottom();
    refresh();
  });
  conversation.on('scroll', () => {
    if (restoringConversationScroll) return;
    conversationScrollOffset = conversation.childBase;
    conversationFollowOutput = conversationAtBottom();
  });
  screen.key(['pageup', 'pagedown'], (_ch, key) => {
    selection = undefined;
    if (!composerPinned && screen.focused !== conversation) return;
    focusConversation();
    conversation.scroll((key.name === 'pageup' ? -1 : 1) * Math.max(1, Number(conversation.height) - 2));
    screen.render();
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
      screen.render();
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
  screen.key(['C-c'], () => {
    const range = orderedSelection();
    if (!range || !selection) { close(); return; }
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
