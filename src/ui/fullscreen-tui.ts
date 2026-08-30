import blessed from 'blessed';

import type { BackendConfig } from '../backend.js';
import type { AgentConfig, AgentModelConfig } from '../config.js';
import type { AgentEvent, AgentInstance, AgentSession } from '../domain/agent.js';
import { renderMarkdown } from '../markdown.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';

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
  background: 'black', panel: 'black', elevated: 'blue', line: 'white',
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

function thinkingScanIntensity(index: number, frame: number, length: number): number {
  const position = (frame * 0.4) % length;
  const distanceFromPosition = Math.abs(index - position);
  const distance = Math.min(distanceFromPosition, length - distanceFromPosition);
  return Math.max(0, Math.min(1, 1 - distance));
}

function thinkingScanColor(index: number, frame: number, length: number): string {
  const intensity = thinkingScanIntensity(index, frame, length);
  const base = [75, 85, 88];
  const bright = [60, 255, 160];
  const channels = base.map((value, channel) => Math.round(value + (bright[channel]! - value) * intensity));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
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
  const composerChars: string[] = [];
  const inputHistory: string[] = [];
  const pendingTurns = new Set<string>();
  const streams = new Map<string, string>();
  const activityLog = new Map<string, string[]>();
  interface ThinkingBlock {
    turnId: string;
    expanded: boolean;
    content: string[];
    status: 'active' | 'completed';
  }
  const thinkingBlocks = new Map<string, ThinkingBlock>();
  const thinkingBlockLines = new Map<string, { headerLine: number }>();
  let latestThinkingTurnId: string | undefined;
  let conversationFollowOutput = true;

  const screen = blessed.screen({
    smartCSR: true, fullUnicode: true, title: 'Coder',
    style: { bg: COLOR.background, fg: COLOR.text },
  });

  const topbar = blessed.box({
    parent: screen, top: 0, left: 0, width: '100%', height: 1, tags: true,
    padding: { left: 1, right: 1 }, style: { bg: COLOR.background, fg: COLOR.muted },
  });
  const conversation = blessed.box({
    parent: screen, top: 1, left: 0, width: '100%', bottom: 3,
    tags: true, scrollable: true, keys: true, vi: true, mouse: true,
    padding: { left: 2, right: 2 },
    style: { bg: COLOR.background, fg: COLOR.text },
  });
  const activity = blessed.list({
    parent: screen, top: 1, right: 0, width: '28%', bottom: 2,
    tags: true, keys: true, vi: true, mouse: true,
    scrollable: true, padding: { left: 1, right: 1 },
    style: {
      bg: COLOR.background, fg: COLOR.muted,
      selected: { bg: COLOR.elevated, fg: COLOR.text },
    },
  });
  const composer = blessed.box({
    parent: screen, bottom: 1, left: 3, width: '100%-4', height: 2,
    input: true, keys: true, mouse: true, padding: { left: 0, right: 1 },
    style: { bg: COLOR.background, fg: COLOR.text },
  });
  const composerPrompt = blessed.box({
    parent: screen, bottom: 1, left: 1, width: 2, height: 2,
    content: '›', style: { bg: COLOR.background, fg: COLOR.accent },
  });
  const footer = blessed.box({
    parent: screen, bottom: 0, left: 1, width: '100%-2', height: 1, tags: true,
    style: { bg: COLOR.background, fg: COLOR.muted },
  });

  const composerContentWidth = (): number => {
    const lpos = composer.lpos;
    if (lpos && lpos.xl > lpos.xi) {
      return Math.max(1, (lpos.xl - lpos.xi) - Number(composer.iwidth));
    }
    const screenWidth = typeof screen.width === 'number' ? screen.width : 80;
    return Math.max(1, screenWidth - (activityVisible ? 32 : 4));
  };

  const composerVisibleStart = (width: number): number =>
    Math.max(0, Math.min(composerCursor - width + 1, composerChars.length - width));

  const placeComposerCursor = (): void => {
    if (closed || screen.focused !== composer) return;
    const lpos = composer.lpos;
    if (!lpos) return;
    const contentWidth = Math.max(1, (lpos.xl - lpos.xi) - Number(composer.iwidth));
    const start = composerVisibleStart(contentWidth);
    const column = Number(composer.strWidth(composerChars.slice(start, composerCursor).join('')));
    screen.program.cursorPos(lpos.yi + Number(composer.itop), lpos.xi + Number(composer.ileft) + column);
  };

  const composerValue = (): string => composerChars.join('');

  const setComposerValue = (value: string): void => {
    composerChars.splice(0, composerChars.length, ...Array.from(value));
    composerCursor = composerChars.length;
    historyIndex = undefined;
    historyDraft = '';
  };

  const renderComposer = (): void => {
    const width = composerContentWidth();
    const start = composerVisibleStart(width);
    composer.setContent(composerChars.slice(start, start + width).join(''));
  };

  const renderComposerFrame = (): void => {
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
    if (key.name === 'enter' || key.name === 'return') { void submit(); return; }
    if (key.name === 'left') composerCursor = Math.max(0, composerCursor - 1);
    else if (key.name === 'right') composerCursor = Math.min(composerChars.length, composerCursor + 1);
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) composerCursor = 0;
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) composerCursor = composerChars.length;
    else if (key.name === 'up' && (composerChars.length === 0 || historyIndex !== undefined)) { updateHistory(-1); return; }
    else if (key.name === 'down' && (composerChars.length === 0 || historyIndex !== undefined)) { updateHistory(1); return; }
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
    const width = Math.min(88, Math.max(44, ...items.map((item) => item.length + 8)));
    const modal = blessed.box({
      parent: screen, top: 'center', left: 'center', width, height: Math.min(items.length + 4, 22),
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

  const ask = (label: string, initial = ''): Promise<string> => new Promise((resolveAnswer) => {
    composerPinned = false;
    const prompt = blessed.prompt({
      parent: screen, top: 'center', left: 'center', width: '72%', height: 7,
      label: ` ${label} `, border: { type: 'line' },
      style: { bg: COLOR.background, fg: COLOR.text, border: { fg: COLOR.line }, label: { fg: COLOR.accent } },
    });
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

  const renderHeader = (): void => {
    const active = instances().filter((item) => item.status === 'running' || item.status === 'waiting' || item.status === 'queued').length;
    const activityText = active ? ` · ${active} active` : '';
    topbar.setContent(`{${COLOR.accent}-fg}coder{/${COLOR.accent}-fg}  {${COLOR.muted}-fg}${safe(sessionId)} · ${safe(activeModel)}${activityText}{/${COLOR.muted}-fg}`);
  };

  const conversationAtBottom = (): boolean => {
    const lpos = conversation.lpos;
    if (!lpos) return conversationFollowOutput;
    const viewportHeight = Math.max(0, (lpos.yl - lpos.yi) - Number(conversation.iheight));
    const scrollHeight = conversation.getScrollHeight();
    if (scrollHeight <= viewportHeight) return true;
    return conversation.getScroll() >= scrollHeight - viewportHeight - 1;
  };

  const renderConversation = (): void => {
    session = runtime.getSession(sessionId) ?? session;
    const shouldFollowOutput = conversationFollowOutput || conversationAtBottom();
    const lines: string[] = [];
    const screenWidth = typeof screen.width === 'number' ? screen.width : 80;
    const markdownCols = Math.max(40, Math.min(120, screenWidth - (activityVisible ? 32 : 6)));
    if (!session.messages.length && !streams.size && thinkingBlocks.size === 0) {
      lines.push('', `{${COLOR.muted}-fg}What would you like to build?{/${COLOR.muted}-fg}`, '',
        `{${COLOR.muted}-fg}Talk naturally. Complex work is coordinated quietly in the background.{/${COLOR.muted}-fg}`);
    }
    const renderedBlocks = new Set<string>();
    for (const message of session.messages) {
      const user = message.role === 'user';
      const prefix = user
        ? `{${COLOR.violet}-fg}›{/${COLOR.violet}-fg} `
        : message.role === 'system'
          ? `{${COLOR.amber}-fg}·{/${COLOR.amber}-fg} `
          : '';
      const content = message.role === 'assistant'
        ? safe(renderMarkdown(message.content, markdownCols))
        : safe(message.content);
      lines.push('', `${prefix}${content}`, '');
      if (message.role === 'user' && message.turnId && thinkingBlocks.has(message.turnId)) {
        renderedBlocks.add(message.turnId);
        renderThinkingBlock(lines, thinkingBlocks.get(message.turnId)!);
      }
    }
    if (pendingTurns.size > 0) {
      const turnId = [...pendingTurns][0];
      if (!thinkingBlocks.has(turnId)) {
        thinkingBlocks.set(turnId, { turnId, expanded: false, content: [], status: 'active' });
      }
      if (!renderedBlocks.has(turnId)) {
        renderThinkingBlock(lines, thinkingBlocks.get(turnId)!);
      }
    }
    for (const [turnId, text] of streams.entries()) {
      if (!text.trim()) continue;
      lines.push('', `{${COLOR.muted}-fg}…{/${COLOR.muted}-fg}`, safe(renderMarkdown(text, markdownCols)), '');
    }
    conversation.setContent(lines.join('\n'));
    if (shouldFollowOutput) conversation.setScrollPerc(100);
    conversationFollowOutput = conversationAtBottom();
  };

  const renderThinkingBlock = (lines: string[], block: ThinkingBlock): void => {
    const headerLine = lines.length;
    const toggle = block.expanded ? '▼' : '▶';
    const icon = block.status === 'active'
      ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][spinnerFrame % 10]
      : toggle;
    const color = block.status === 'active' ? COLOR.accent : COLOR.green;
    const label = block.status === 'active' ? 'Thinking' : 'Thought';
    if (block.status === 'active') {
      const scanLabel = [...label].map((character, index) => {
        const shade = thinkingScanColor(index, spinnerFrame, label.length);
        const intensity = thinkingScanIntensity(index, spinnerFrame, label.length);
        const text = intensity > 0.7 ? `{bold}${character}{/bold}` : character;
        return `{${shade}-fg}${text}{/${shade}-fg}`;
      }).join('');
      lines.push(`{${color}-fg}${icon}{/${color}-fg} ${scanLabel}`);
    } else {
      lines.push(`{${color}-fg}${icon} ${label}{/${color}-fg}`);
    }
    thinkingBlockLines.set(block.turnId, { headerLine });
    latestThinkingTurnId = block.turnId;
    if (block.expanded) {
      const content = block.content.length > 0 ? block.content : ['(no tool calls logged)'];
      for (const c of content) {
        lines.push(`  {${COLOR.muted}-fg}${safe(c)}{/${COLOR.muted}-fg}`);
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
      conversation.width = '72%';
      composer.width = '72%-4';
      composerPrompt.left = '72%-3';
    } else {
      activity.hide();
      conversation.width = '100%';
      composer.width = '100%-4';
      composerPrompt.left = 1;
    }
  };

  const refresh = (): void => {
    layout();
    renderHeader();
    renderConversation();
    renderActivity();
    renderComposer();
    footer.setContent(`{${COLOR.muted}-fg}Enter send · Ctrl+K commands · Ctrl+B activity · Ctrl+Y expand/think · /provider · /model · Ctrl+C exit{/${COLOR.muted}-fg}`);
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
      apiKey = await ask(`API key · blank uses ${envName}`) || process.env[envName];
      if (!apiKey) return;
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
    sessionId = id;
    session = await runtime.openSession(id);
    activeModel = session.defaultModel ?? options.modelName;
    streams.clear();
    activityLog.clear();
    thinkingBlocks.clear();
    thinkingBlockLines.clear();
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
        refresh();
        break;
      case 'cancel': {
        const target = instances().find((item) => item.instanceId === args[0] || item.instanceId.startsWith(args[0] ?? ''));
        const main = runtime.getInstance(session.mainInstanceId);
        if (target && main && target.instanceId !== main.instanceId) await runtime.cancelAgent(main.instanceId, target.instanceId);
        break;
      }
      case 'help': await commandPalette(); break;
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
    if (index === 5) await runtime.clearSession(sessionId);
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
        const turnId = await runtime.submitMessage(sessionId, value);
        pendingTurns.add(turnId);
        if (!thinkingBlocks.has(turnId)) {
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
    const eventSession = 'sessionId' in event ? event.sessionId : 'instance' in event ? event.instance.sessionId : undefined;
    if (eventSession && eventSession !== sessionId) return;
    if (event.type === 'assistant_delta') streams.set(event.turnId, `${streams.get(event.turnId) ?? ''}${event.text}`);
    if (event.type === 'assistant_message') {
      streams.delete(event.message.turnId ?? '');
      const active = [...thinkingBlocks.values()].find((b) => b.status === 'active');
      if (active) {
        active.status = 'completed';
        active.expanded = false;
      }
      pendingTurns.clear();
      stopSpinner();
    }
    if (event.type === 'tool_started' && event.instanceId === session.mainInstanceId) {
      const block = [...thinkingBlocks.values()].find(b => b.status === 'active');
      if (block) {
        block.content.push(`→ ${event.tool}  ${oneLine(event.input, 60)}`);
      }
    }
    if (event.type === 'tool_finished' && event.instanceId === session.mainInstanceId) {
      const block = [...thinkingBlocks.values()].find(b => b.status === 'active');
      if (block) {
        block.content.push(`✓ ${event.tool}  ${oneLine(event.output, 60)}`);
      }
    }
    if (event.type === 'runtime_error') {
      if (event.sessionId === sessionId && event.instanceId === session.mainInstanceId) {
        pendingTurns.clear();
        stopSpinner();
      }
    }
    if (event.type === 'instance_updated'
      && event.instance.sessionId === sessionId
      && event.instance.instanceId === session.mainInstanceId
      && ['idle', 'failed', 'cancelled'].includes(event.instance.status)) {
      const block = [...thinkingBlocks.values()].find(b => b.status === 'active');
      if (block) {
        block.status = 'completed';
        block.expanded = false;
      }
      pendingTurns.clear();
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
    unsubscribe();
    screen.destroy();
    finish?.();
  }

  composer.on('keypress', handleComposerKey);
  activity.key(['enter', 'space'], () => { void showActivityDetail(); });
  activity.on('select item', (_item, index) => { selectedActivityIndex = index; });
  const openCommandPalette = (): void => {
    void commandPalette();
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
    block.expanded = !block.expanded;
    refresh();
  };

  conversation.on('click', (data: { x: number; y: number }) => {
    if (!data || data.y === undefined) { focusComposer(); return; }
    const lpos = conversation.lpos;
    if (!lpos) { focusComposer(); return; }
    const contentTop = lpos.yi + Number(conversation.itop);
    const relY = data.y - contentTop;
    const row = Math.floor(relY) + Number(conversation.getScroll?.() ?? conversation.childBase ?? 0);
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
    focusComposer();
  });
  screen.key(['C-y'], () => {
    if (latestThinkingTurnId) toggleThinkingBlock(latestThinkingTurnId);
  });
  activity.on('click', focusComposer);
  conversation.on('scroll', () => {
    conversationFollowOutput = conversationAtBottom();
  });
  screen.key(['tab'], focusComposer);
  screen.key(['escape'], focusComposer);
  screen.key(['C-c'], close);
  screen.on('resize', refresh);

  refresh();
  focusComposer();
  await done;
}
