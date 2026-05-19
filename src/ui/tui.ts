/**
 * Minimal blessed TUI: one readable master output stream and one prompt input.
 */

import blessed from 'blessed';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';

import { renderMarkdown } from '../markdown.js';
import { ConversationStore, type ConversationEntry } from '../store.js';
import type { BackendConfig } from '../backend.js';
import type { MasterCoordinator } from '../runtime/coordinator.js';
import type { ClarificationRequest, LlmTraceEntry, PromptTask, TaskMode, TaskPhase, TaskStatus } from '../domain/task.js';

const PHASE_LABELS: Record<TaskPhase, string> = {
  plan: 'Planning',
  execute: 'Executing',
  design: 'Designing',
  inspect_code: 'Inspecting',
  write_code: 'Writing',
  verify: 'Verifying',
  finalize: 'Finalizing',
};

type TaskView = {
  taskId: string;
  title: string;
  prompt: string;
  mode: TaskMode;
  kind?: string;
  relatedTaskIds?: string[];
  pendingMailboxUpdates: number;
  lines: string[];
  stream: string;
  llmTrace: LlmTraceEntry[];
  status: string;
  updatedAt: string;
};

type ResolvedModel = {
  name: string;
  config: BackendConfig;
};

type ResolveModel = (name?: string) => ResolvedModel;
type PersistModelSelection = (name: string) => Promise<void>;
type RunTuiOptions = {
  verbose?: boolean;
};
type BlessedScreen = blessed.Widgets.Screen & {
  _listenedMouse?: boolean;
  leave?: () => void;
};
type BlessedPromptInput = blessed.Widgets.TextareaElement & {
  readInput: (callback?: ((err: Error | null, value: string | null) => void) | null) => void;
  _reading?: boolean;
  _done?: (err: string | Error | null, value?: string | null) => void;
  _listener?: (ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg) => void;
};
type BlessedModelPicker = blessed.Widgets.ListElement & {
  selected: number;
};
type BlessedScrollableBox = blessed.Widgets.BoxElement & {
  scroll: (offset: number, always?: boolean) => unknown;
  scrollTo: (offset: number, always?: boolean) => unknown;
  getScroll: () => number;
  getScrollHeight: () => number;
  setScroll: (offset: number) => unknown;
  setScrollPerc: (percent: number) => unknown;
};
type BlessedProgramWithAlt = {
  normalBuffer: () => unknown;
  alternateBuffer?: () => unknown;
  isAlt?: boolean;
};

const THEME = {
  bg: '#0b1117',
  panel: '#101821',
  panelElevated: '#1d2b39',
  panelSoft: '#1a2633',
  text: '#d7e0ea',
  textMuted: '#7f92a6',
  textSoft: '#a9b7c6',
  model: '#cdd6df',
  accent: '#6fb1d6',
  accentStrong: '#8ac3e6',
  planAccent: '#d987c7',
  planAccentStrong: '#f0a8dc',
  success: '#7fb98f',
  warning: '#d0a86e',
  danger: '#c97c7c',
} as const;

function simplifyText(text: string, max = 90): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (!single) return '';
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function titleForTask(task: PromptTask): string {
  return simplifyText(task.summary || task.planner?.summary || task.prompt, 72);
}

function phaseText(phase: TaskPhase, note?: string): string {
  return `${PHASE_LABELS[phase]}${note ? `: ${note}` : ''}`;
}

function renderTraceMessage(entry: LlmTraceEntry): string {
  const userMessages = entry.messages
    .filter((message) => message.content)
    .map((message) => `${message.role}: ${message.content ?? ''}`)
    .join('\n');
  const prompt = simplifyText(`${entry.systemPrompt}\n${userMessages}`, 260);
  const response = simplifyText(entry.response || '[no text response]', 260);
  const tools = entry.toolCalls?.map((call) => call.function.name).filter(Boolean).join(', ');
  const cached = entry.cached ? ' cached' : '';
  return [
    chalk.bold.hex(THEME.warning)(`LLM ${entry.label}${cached}`),
    `${chalk.hex(THEME.textMuted)('prompt')} ${chalk.hex(THEME.textSoft)(prompt)}`,
    `${chalk.hex(THEME.textMuted)('reply')} ${chalk.hex(THEME.textSoft)(response)}`,
    tools ? `${chalk.hex(THEME.textMuted)('tools')} ${chalk.hex(THEME.textSoft)(tools)}` : '',
  ].filter(Boolean).join('\n');
}

function renderTrace(view: TaskView, verbose: boolean): string[] {
  if (!verbose || view.llmTrace.length === 0) return [];
  const entries = view.llmTrace.slice(-4).map(renderTraceMessage);
  return [
    '',
    chalk.bold.hex(THEME.warning)('LLM Trace'),
    ...entries,
  ];
}

function formatTimestamp(value?: string): string {
  if (!value) return '--:--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function statusColor(status: TaskStatus | string): string {
  switch (status) {
    case 'completed':
      return THEME.success;
    case 'failed':
      return THEME.danger;
    case 'blocked':
    case 'waiting_user':
      return THEME.warning;
    case 'running':
      return THEME.accentStrong;
    default:
      return THEME.textMuted;
  }
}

function modeColor(taskMode: TaskMode): string {
  return taskMode === 'plan' ? THEME.planAccentStrong : THEME.accentStrong;
}

function modeSoftColor(taskMode: TaskMode): string {
  return taskMode === 'plan' ? THEME.planAccent : THEME.accent;
}

function renderTaskMeta(view: TaskView): string {
  const modeLabel = chalk.hex(modeColor(view.mode))(view.mode.toUpperCase());
  const statusLabel = chalk.hex(statusColor(view.status))(view.status.replace(/_/g, ' ').toUpperCase());
  const updatedLabel = chalk.hex(THEME.textMuted)(`updated ${formatTimestamp(view.updatedAt)}`);
  const kindLabel = view.kind && view.kind !== 'worker' ? chalk.hex(THEME.textSoft)(view.kind.replace(/_/g, ' ')) : '';
  const mailboxLabel = view.pendingMailboxUpdates > 0 ? chalk.hex(THEME.warning)(`${view.pendingMailboxUpdates} pending update${view.pendingMailboxUpdates === 1 ? '' : 's'}`) : '';
  return [modeLabel, statusLabel, kindLabel, mailboxLabel, updatedLabel].filter(Boolean).join('  ');
}

function renderTask(view: TaskView, verbose: boolean): string {
  const body = [...view.lines];
  if (view.stream.trim()) body.push(renderMarkdown(view.stream, 96));
  body.push(...renderTrace(view, verbose));
  const divider = chalk.hex(THEME.panelElevated)('─'.repeat(72));

  return [
    divider,
    renderTaskMeta(view),
    chalk.bold.hex(THEME.text)(view.title),
    `${chalk.hex(THEME.textMuted)('Prompt')} ${chalk.hex(THEME.textSoft)(view.prompt)}`,
    '',
    ...body.map((line) => (line.trim() ? `${chalk.hex(THEME.textMuted)('│')} ${line}` : line)),
  ].join('\n');
}

function ensurePromptReading(
  inputBox: BlessedPromptInput,
  modelPickerOpen: boolean,
  exiting: boolean,
  scheduleState: { pending: boolean },
): void {
  if (scheduleState.pending || modelPickerOpen || exiting) return;
  scheduleState.pending = true;
  setImmediate(() => {
    scheduleState.pending = false;
    if (modelPickerOpen || exiting) return;
    inputBox.focus();
    inputBox.screen.program.showCursor();
  });
}

function promptLineCount(text: string, cols: number): number {
  const width = Math.max(1, cols);
  return Math.max(
    1,
    text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0),
  );
}

function pausePromptReading(inputBox: BlessedPromptInput, scheduleState: { pending: boolean }): void {
  scheduleState.pending = false;
  if (!inputBox._reading) return;
  inputBox._done?.('stop');
}

const SHIFT_ENTER_SEQUENCES = ['\x1b[13;2u', '\x1b[13;2~', '\x1b[27;2;13~'] as const;
const CTRL_C_SEQUENCES = ['\x1b[99;5u', '\x1b[27;5;99~'] as const;
const ENABLE_ENHANCED_KEYS = '\x1b[>1u\x1b[>4;2m';
const DISABLE_ENHANCED_KEYS = '\x1b[<u\x1b[>4;0m';

function isShiftEnterSequence(value: string): boolean {
  return SHIFT_ENTER_SEQUENCES.some((sequence) => value === sequence);
}

function printableShiftEnterTail(value: string): string {
  return value.replace(/\x1b\[/g, '').replace(/\x1b/g, '');
}

function printableTailForSequences(value: string, sequences: readonly string[]): string {
  const tails: string[] = [];
  let rest = value;
  while (rest) {
    const next = sequences
      .map((sequence) => ({ sequence, index: rest.indexOf(sequence) }))
      .filter((item) => item.index >= 0)
      .sort((left, right) => left.index - right.index)[0];
    if (!next) break;
    tails.push(printableShiftEnterTail(next.sequence));
    rest = rest.slice(next.index + next.sequence.length);
  }
  return tails.join('');
}

const SEND_ANIMATION_INTERVAL_MS = 33;
const SEND_ANIMATION_DURATION_MS = 900;
const SEND_ANIMATION_GLYPH = '>>>';
const INPUT_DIVIDER_CHAR = '─';

function mixHexColor(fromHex: string, toHex: string, amount: number): string {
  const parse = (hex: string): [number, number, number] => {
    const value = hex.replace('#', '');
    const normalized = value.length === 3
      ? value.split('').map((part) => part + part).join('')
      : value.padEnd(6, '0').slice(0, 6);
    return [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
    ];
  };
  const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
  const [fr, fg, fb] = parse(fromHex);
  const [tr, tg, tb] = parse(toHex);
  const mix = (start: number, end: number): number => clamp(start + (end - start) * amount);
  return `#${[mix(fr, tr), mix(fg, tg), mix(fb, tb)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function easeInExpo(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return 2 ** (10 * value - 10);
}

function renderDividerAnimationFrame(width: number, elapsedMs: number, modeColorValue: string): string {
  const normalizedWidth = Math.max(1, width);
  const progress = easeInExpo(Math.max(0, Math.min(1, elapsedMs / SEND_ANIMATION_DURATION_MS)));
  const baseColor = mixHexColor(modeColorValue, THEME.panelSoft, 0.55);
  const trailNearColor = mixHexColor(modeColorValue, THEME.panelSoft, 0.18);
  const trailFarColor = mixHexColor(modeColorValue, THEME.panelSoft, 0.42);
  const headColor = modeColorValue;
  const chars = new Array<string>(normalizedWidth).fill(chalk.hex(baseColor)(INPUT_DIVIDER_CHAR));
  const glyphChars = Array.from(SEND_ANIMATION_GLYPH);
  const glyphWidth = glyphChars.length;
  const travel = progress * (normalizedWidth + glyphWidth - 1);
  const start = Math.floor(travel) - glyphWidth + 1;
  const trailWidth = Math.max(4, Math.floor(normalizedWidth * 0.18));

  for (let offset = 0; offset < glyphWidth; offset += 1) {
    const index = start + offset;
    if (index < 0 || index >= normalizedWidth) continue;
    chars[index] = chalk.bold.hex(headColor)(glyphChars[offset] ?? '>');
  }

  for (let offset = 0; offset < trailWidth; offset += 1) {
    const index = start - offset - 1;
    if (index < 0 || index >= normalizedWidth) continue;
    const trailProgress = 1 - (offset / Math.max(1, trailWidth));
    const trailColor = mixHexColor(trailFarColor, trailNearColor, trailProgress);
    const trailChar = offset < 2 ? '>' : (offset < Math.floor(trailWidth * 0.45) ? '━' : '─');
    chars[index] = chalk.hex(trailColor)(trailChar);
  }

  return chars.join('');
}

export async function runTui(
  master: MasterCoordinator,
  modelName: string,
  resolveModel?: ResolveModel,
  modelAliases: string[] = [],
  persistModelSelection?: PersistModelSelection,
  options: RunTuiOptions = {},
): Promise<void> {
  const convStore = new ConversationStore();
  await convStore.init();

  const sessionId = `session-${Date.now()}`;
  const history: ConversationEntry[] = [];
  const tasks = new Map<string, TaskView>();
  const taskOrder: string[] = [];
  let mode: TaskMode = 'execute';
  let activeModelName = modelName;
  let activeClarification: ClarificationRequest | undefined;
  let exiting = false;
  let modelPickerOpen = false;
  let modelPicker: BlessedModelPicker | undefined;
  let modelPickerItems: string[] = [];
  let sendAnimationStartedAt: number | undefined;
  let sendAnimationTimer: NodeJS.Timeout | undefined;
  const promptReadState = { pending: false };

  const ProgramCtor = (blessed as unknown as { Program: { prototype: BlessedProgramWithAlt } }).Program;
  const originalAlternateBuffer = ProgramCtor.prototype.alternateBuffer;
  ProgramCtor.prototype.alternateBuffer = function noAlternateBuffer(this: BlessedProgramWithAlt) {
    this.isAlt = false;
    return '';
  };
  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    dockBorders: false,
    terminal: 'xterm',
    useBCE: false,
    title: 'Coding Agent',
  }) as BlessedScreen;
  ProgramCtor.prototype.alternateBuffer = originalAlternateBuffer;
  screen.program.disableMouse();

  const outputBox = blessed.box({
    top: 3,
    left: 0,
    right: 0,
    bottom: 4,
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: false,
    vi: false,
    style: {
      bg: THEME.bg,
      fg: THEME.text,
      scrollbar: { bg: THEME.panelSoft },
    },
    content: '',
  }) as BlessedScrollableBox;

  const inputShell = blessed.box({
    bottom: 1,
    left: 0,
    right: 0,
    height: 4,
    tags: true,
    style: {
      bg: THEME.panelElevated,
      fg: THEME.text,
    },
  });

  const headerBox = blessed.box({
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    tags: true,
    style: {
      bg: THEME.panel,
      fg: THEME.text,
    },
  });

  const headerTitle = blessed.box({
    parent: headerBox,
    top: 0,
    left: 1,
    right: 1,
    height: 1,
    tags: true,
    style: {
      bg: THEME.panel,
      fg: THEME.text,
    },
    content: '',
  });

  const headerSubtitle = blessed.box({
    parent: headerBox,
    top: 1,
    left: 1,
    right: 1,
    height: 1,
    tags: true,
    style: {
      bg: THEME.panel,
      fg: THEME.textMuted,
    },
    content: '',
  });

  const headerDivider = blessed.box({
    parent: headerBox,
    top: 2,
    left: 0,
    right: 0,
    height: 1,
    tags: true,
    style: {
      bg: THEME.panel,
      fg: THEME.panelElevated,
    },
    content: '',
  });

  const inputDivider = blessed.box({
    parent: inputShell,
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    tags: false,
    style: {
      bg: THEME.panelElevated,
      fg: THEME.accent,
    },
    content: INPUT_DIVIDER_CHAR.repeat(Math.max(1, process.stdout.columns ?? 80)),
  });

  const promptMarker = blessed.box({
    parent: inputShell,
    top: 1,
    left: 1,
    width: 1,
    height: 1,
    tags: false,
    content: '›',
    style: {
      bg: THEME.panelElevated,
      fg: THEME.text,
    },
  });

  const inputBox = blessed.textarea({
    parent: inputShell,
    top: 1,
    left: 3,
    right: 1,
    height: 1,
    tags: true,
    inputOnFocus: false,
    keys: false,
    scrollable: false,
    style: {
      bg: THEME.panelElevated,
      fg: THEME.text,
      focus: { bg: THEME.panelElevated, fg: THEME.text },
    },
  }) as BlessedPromptInput;

  const dividerWidth = (): number => Math.max(1, (process.stdout.columns ?? 80) - 1);

  const stopSendAnimation = (): void => {
    sendAnimationStartedAt = undefined;
    if (!sendAnimationTimer) return;
    clearInterval(sendAnimationTimer);
    sendAnimationTimer = undefined;
  };

  const renderInputDivider = (modeColorValue: string): void => {
    inputDivider.style.fg = modeColorValue;
    const width = dividerWidth();
    const content = sendAnimationStartedAt === undefined
      ? chalk.hex(modeColorValue)(INPUT_DIVIDER_CHAR.repeat(width))
      : renderDividerAnimationFrame(width, Date.now() - sendAnimationStartedAt, modeColorValue);
    inputDivider.setContent(content);
  };

  const startSendAnimation = (): void => {
    stopSendAnimation();
    sendAnimationStartedAt = Date.now();
    sendAnimationTimer = setInterval(() => {
      if (exiting) return;
      if (sendAnimationStartedAt === undefined) return;
      const elapsed = Date.now() - sendAnimationStartedAt;
      if (elapsed >= SEND_ANIMATION_DURATION_MS) {
        stopSendAnimation();
        renderAll();
        return;
      }
      renderAll();
    }, SEND_ANIMATION_INTERVAL_MS);
    sendAnimationTimer.unref?.();
  };

  const resizePrompt = (): void => {
    const width = Math.max(1, (process.stdout.columns ?? 80) - 4);
    const maxLines = Math.max(1, Math.floor(((process.stdout.rows ?? 24) - 9) / 2));
    const lines = Math.min(promptLineCount(inputBox.getValue(), width), maxLines);
    const shellHeight = lines + 2;
    inputShell.height = shellHeight;
    inputBox.height = lines;
    outputBox.bottom = shellHeight + 1;
    promptMarker.top = 1;
  };

  const statusBox = blessed.box({
    bottom: 0,
    left: 0,
    right: 0,
    height: 1,
    tags: true,
    style: {
      bg: THEME.panel,
      fg: THEME.textMuted,
    },
    content: '',
  });
  const statusModel = blessed.box({
    parent: statusBox,
    top: 0,
    left: 0,
    height: 1,
    width: 'shrink',
    tags: true,
    style: {
      bg: THEME.panel,
      fg: THEME.textMuted,
    },
    content: '',
  });
  const statusSeparator = blessed.box({
    parent: statusBox,
    top: 0,
    height: 1,
    width: 3,
    tags: true,
    align: 'center',
    style: {
      bg: THEME.panel,
      fg: THEME.textMuted,
    },
    content: ' | ',
  });
  const statusMode = blessed.box({
    parent: statusBox,
    top: 0,
    right: 0,
    height: 1,
    width: 'shrink',
    tags: true,
    style: {
      bg: THEME.panel,
      fg: THEME.textMuted,
    },
    content: '',
  });

  screen.append(headerBox);
  screen.append(outputBox);
  screen.append(inputShell);
  screen.append(statusBox);

  let followOutput = true;
  let outputScrollOffset = 0;

  const clampOutputScroll = (): number => Math.max(0, Math.min(outputScrollOffset, outputBox.getScrollHeight()));

  const applyOutputScroll = (): void => {
    if (followOutput) {
      outputScrollOffset = outputBox.getScrollHeight();
    }
    outputBox.setScroll(clampOutputScroll());
  };

  const saveHistory = async (): Promise<void> => {
    await convStore.save(sessionId, history);
  };

  const ensureTaskView = (task: PromptTask): TaskView => {
    let view = tasks.get(task.taskId);
    if (!view) {
      view = {
        taskId: task.taskId,
        title: titleForTask(task),
        prompt: task.prompt,
        mode: task.mode,
        kind: task.kind,
        relatedTaskIds: task.relatedTaskIds ? [...task.relatedTaskIds] : undefined,
        pendingMailboxUpdates: (task.mailbox ?? []).filter((message) => message.status === 'pending').length,
        lines: [],
        stream: '',
        llmTrace: task.llmTrace ?? [],
        status: task.status,
        updatedAt: task.updatedAt ?? new Date().toISOString(),
      };
      tasks.set(task.taskId, view);
      taskOrder.push(task.taskId);
    }
    view.title = titleForTask(task);
    view.prompt = task.prompt;
    view.mode = task.mode;
    view.kind = task.kind;
    view.relatedTaskIds = task.relatedTaskIds ? [...task.relatedTaskIds] : undefined;
    view.pendingMailboxUpdates = (task.mailbox ?? []).filter((message) => message.status === 'pending').length;
    view.llmTrace = task.llmTrace ?? [];
    view.status = task.status;
    view.updatedAt = task.updatedAt ?? view.updatedAt;
    return view;
  };

  const renderAll = (): void => {
    const chunks = taskOrder
      .map((taskId) => tasks.get(taskId))
      .filter((view): view is TaskView => Boolean(view))
      .map((view) => renderTask(view, Boolean(options.verbose)));

    const intro = tasks.size === 0
      ? [
          chalk.bold.hex(THEME.text)('Coder workspace is ready'),
          [
            chalk.hex(THEME.textMuted)('Model'),
            chalk.bold.hex(THEME.model)(activeModelName),
            chalk.hex(THEME.textMuted)('•'),
            chalk.hex(THEME.textMuted)('Mode'),
            chalk.hex(modeColor(mode))(mode),
          ].join(' '),
        ].join('\n')
      : chunks.join('\n\n');

    outputBox.setContent(intro);
    applyOutputScroll();
    resizePrompt();
    const width = Math.max(20, (process.stdout.columns ?? 80) - 1);
    const activeTask = [...taskOrder]
      .reverse()
      .map((taskId) => tasks.get(taskId))
      .find((view): view is TaskView => Boolean(view && view.taskId !== '__system__'));
    const taskCount = taskOrder.filter((taskId) => taskId !== '__system__').length;
    const activeModeColor = modeColor(mode);
    const titleContent = [
      chalk.bold.hex(THEME.text)('Coder'),
      chalk.bold.hex(THEME.model)(`  ${activeModelName}`),
      chalk.hex(activeModeColor)(mode.toUpperCase()),
    ].join('  ');
    const subtitleParts = [
      taskCount === 0 ? 'No active tasks yet' : `${taskCount} task${taskCount === 1 ? '' : 's'} in session`,
      activeTask ? `focused on ${simplifyText(activeTask.title, 42)}` : 'ready for a new request',
    ];
    headerTitle.setContent(titleContent);
    headerSubtitle.setContent(chalk.hex(THEME.textMuted)(subtitleParts.join('  •  ')));
    headerDivider.setContent(chalk.hex(THEME.panelElevated)('─'.repeat(width)));
    const rightWidth = activeModelName.length + mode.length + 3;
    statusBox.setContent(' '.repeat(width));
    statusModel.setContent(activeModelName);
    statusModel.style.fg = THEME.model;
    statusSeparator.setContent(' | ');
    statusSeparator.style.fg = THEME.textMuted;
    statusMode.setContent(mode);
    statusMode.style.fg = activeModeColor;
    statusMode.left = Math.max(0, width - mode.length);
    statusSeparator.left = Math.max(0, statusMode.left - 3);
    statusModel.left = Math.max(0, statusSeparator.left - activeModelName.length);
    statusModel.width = activeModelName.length;
    promptMarker.style.fg = THEME.text;
    inputBox.style.focus = { bg: THEME.panelElevated, fg: activeModeColor };
    renderInputDivider(activeModeColor);
    screen.render();
    ensurePromptReading(inputBox, modelPickerOpen, exiting, promptReadState);
  };

  const appendLine = (taskId: string, line: string): void => {
    const task = master.getTask(taskId);
    if (!task) return;
    const view = ensureTaskView(task);
    if (view.stream.trim()) {
      view.lines.push(renderMarkdown(view.stream, 96));
      view.stream = '';
    }
    view.lines.push(line);
    view.lines = view.lines.slice(-500);
  };

  const appendStream = (taskId: string, text: string): void => {
    const task = master.getTask(taskId);
    if (!task) return;
    const view = ensureTaskView(task);
    view.stream += text;
  };

  const logSystem = (line: string): void => {
    const id = '__system__';
    let view = tasks.get(id);
    if (!view) {
      view = {
        taskId: id,
        title: 'Session',
        prompt: 'System messages',
        mode,
        pendingMailboxUpdates: 0,
        lines: [],
        stream: '',
        llmTrace: [],
        status: 'idle',
        updatedAt: new Date().toISOString(),
      };
      tasks.set(id, view);
      taskOrder.push(id);
    }
    view.lines.push(line);
  };

  const closeModelPicker = (): void => {
    if (!modelPickerOpen) return;
    modelPicker?.detach();
    modelPicker = undefined;
    modelPickerItems = [];
    modelPickerOpen = false;
    ensurePromptReading(inputBox, modelPickerOpen, exiting, promptReadState);
    renderAll();
  };

  const applyModelSelection = async (requested: string): Promise<void> => {
    if (!resolveModel) {
      logSystem(chalk.hex(THEME.warning)('/model switching is not configured for this session.'));
      renderAll();
      return;
    }

    try {
      const next = resolveModel(requested);
      master.setBackendConfig(next.config);
      activeModelName = next.name;
      if (persistModelSelection) {
        await persistModelSelection(requested);
      }
      logSystem(chalk.hex(THEME.success)(`Model changed to ${activeModelName}.`));
      if (process.env.AGENT_MODEL) {
        logSystem(chalk.hex(THEME.warning)(`AGENT_MODEL=${process.env.AGENT_MODEL} is set and will override saved config on restart.`));
      }
    } catch (error) {
      logSystem(chalk.hex(THEME.danger)(error instanceof Error ? error.message : String(error)));
    }

    ensurePromptReading(inputBox, modelPickerOpen, exiting, promptReadState);
    renderAll();
  };

  const openModelPicker = (): void => {
    if (modelPickerOpen) return;
    if (modelAliases.length === 0) {
      logSystem(chalk.hex(THEME.warning)('No configured model aliases found. Add entries to .agentrc "models" to enable selection.'));
      renderAll();
      return;
    }

    modelPickerOpen = true;
    pausePromptReading(inputBox, promptReadState);
    screen.grabKeys = false;
    modelPickerItems = Array.from(new Set(modelAliases));
    const selectedIndex = Math.max(0, modelPickerItems.findIndex((item) => item === activeModelName));
    modelPicker = blessed.list({
      parent: screen,
      label: ' Models ',
      top: 'center',
      left: 'center',
      width: '50%',
      height: Math.min(modelPickerItems.length + 4, 16),
      border: 'line',
      keys: false,
      vi: false,
      style: {
        bg: THEME.panel,
        fg: THEME.text,
        border: { fg: THEME.accent },
        selected: { bg: THEME.accent, fg: THEME.bg },
      },
      items: modelPickerItems.map((item) => item === activeModelName ? `${item} (current)` : item),
    }) as BlessedModelPicker;

    screen.focusPush(modelPicker);
    modelPicker.focus();
    modelPicker.select(selectedIndex);
    screen.render();

    modelPicker.on('select', async (_item, index) => {
      const requested = modelPickerItems[index];
      closeModelPicker();
      await applyModelSelection(requested);
    });
  };

  const moveModelPicker = (offset: number): boolean => {
    if (!modelPickerOpen || !modelPicker) return false;
    if (offset < 0) {
      modelPicker.up(Math.abs(offset));
    } else {
      modelPicker.down(offset);
    }
    screen.render();
    return true;
  };

  const chooseModelPickerSelection = (): boolean => {
    if (!modelPickerOpen || !modelPicker) return false;
    const requested = modelPickerItems[modelPicker.selected];
    closeModelPicker();
    if (requested) void applyModelSelection(requested);
    return true;
  };

  const answerClarification = (answer: string): boolean => {
    if (!activeClarification) return false;
    master.answerClarification(activeClarification.taskId, activeClarification.clarificationId, answer);
    appendLine(activeClarification.taskId, chalk.hex(THEME.success)(`You answered: ${answer}`));
    activeClarification = undefined;
    return true;
  };

  async function handleCommand(line: string): Promise<void> {
    const [cmd = '', ...args] = line.slice(1).trim().split(/\s+/);

    if (cmd === 'exit' || cmd === 'quit') {
      shutdown();
      process.exit(0);
    }

    if (cmd === 'mode') {
      const next = args[0] as TaskMode | undefined;
      if (next === 'execute' || next === 'plan' || next === 'react') {
        mode = next;
      } else {
        logSystem(chalk.hex(THEME.warning)('Usage: /mode execute|plan|react'));
      }
      renderAll();
      return;
    }

    if (cmd === 'model') {
      const requested = args[0];
      if (!requested) {
        logSystem(chalk.hex(THEME.textMuted)(`Current model: ${activeModelName}. Use ↑/↓ to choose, Enter to confirm, Esc to cancel.`));
        openModelPicker();
        return;
      }
      await applyModelSelection(requested);
      return;
    }

    if (cmd === 'clear') {
      tasks.clear();
      taskOrder.length = 0;
      history.length = 0;
      await convStore.remove(sessionId);
      renderAll();
      return;
    }

    if (cmd === 'history') {
      logSystem(history.length === 0
        ? chalk.hex(THEME.textMuted)('No conversation history yet.')
        : history.map((entry) => `${entry.role}: ${simplifyText(entry.content, 120)}`).join('\n'));
      renderAll();
      return;
    }

    if (cmd === 'help') {
      logSystem([
        chalk.bold.hex(THEME.accentStrong)('Commands'),
        '/mode execute|plan|react',
        '/model [name]',
        '/clear',
        '/history',
        '/exit',
      ].join('\n'));
      renderAll();
      return;
    }

    logSystem(chalk.hex(THEME.warning)(`Unknown command: /${cmd}`));
    renderAll();
  }

  const submitPrompt = async (text: string): Promise<void> => {
    const userInput = text.trim();
    if (!userInput) return;

    if (activeClarification && !userInput.startsWith('/')) {
      answerClarification(userInput);
      renderAll();
      return;
    }

    if (userInput.startsWith('/')) {
      await handleCommand(userInput);
      return;
    }

    startSendAnimation();
    history.push({ role: 'user', content: userInput });
    await saveHistory();
    await master.acceptPrompt('tui-user', userInput, mode, history.slice(0, -1));
    renderAll();
  };

  const unsubscribe = master.subscribe((event) => {
    if (event.type === 'task_created') {
      const view = ensureTaskView(event.task);
      view.title = 'Working on request';
      view.lines = [
        chalk.bold.hex(THEME.accentStrong)('Master'),
        chalk.hex(THEME.textMuted)('Preparing the request.'),
      ];
      renderAll();
      return;
    }

    if (event.type === 'task_updated') {
      ensureTaskView(event.task);
      renderAll();
      return;
    }

    if (event.type === 'master_response') {
      const related = event.relatedTaskIds?.length ? ` (ref ${event.relatedTaskIds.map((id) => id.slice(0, 8)).join(', ')})` : '';
      logSystem(`${chalk.bold.hex(THEME.accentStrong)(`Master${related}`)}\n${renderMarkdown(event.text, 96)}`);
      renderAll();
      return;
    }

    if (event.type === 'task_mailbox_updated') {
      appendLine(event.taskId, chalk.hex(THEME.warning)(`Master queued an update: ${simplifyText(event.message.text, 140)}`));
      renderAll();
      return;
    }

    if (event.type === 'task_phase') {
      appendLine(event.taskId, chalk.bold.hex(THEME.warning)(phaseText(event.phase, event.note)));
      renderAll();
      return;
    }

    if (event.type === 'task_output') {
      appendStream(event.taskId, event.text);
      renderAll();
      return;
    }

    if (event.type === 'tool_call') {
      if (event.tool === 'write_file' || event.tool === 'edit_file') {
        appendLine(event.taskId, chalk.hex(THEME.accent)(`Editing code: ${simplifyText(event.input, 100)}`));
      } else if (event.tool === 'bash') {
        appendLine(event.taskId, chalk.hex(THEME.textMuted)(`Running: ${simplifyText(event.input, 120)}`));
      } else if (event.tool !== 'read_file' && event.tool !== 'list_dir') {
        appendLine(event.taskId, chalk.hex(THEME.textMuted)(`Using ${event.tool}.`));
      }
      renderAll();
      return;
    }

    if (event.type === 'tool_result') {
      if (event.tool === 'write_file' || event.tool === 'edit_file') {
        appendLine(event.taskId, renderMarkdown(event.output, 96));
      } else if (event.tool === 'bash') {
        appendLine(event.taskId, chalk.hex(THEME.textMuted)(simplifyText(event.output.split('\n')[0] ?? '', 160)));
      }
      renderAll();
      return;
    }

    if (event.type === 'clarification_requested') {
      activeClarification = event.clarification;
      appendLine(event.taskId, chalk.bold.hex(THEME.warning)(`Question: ${event.clarification.question}`));
      if (event.clarification.choices.length > 0) {
        appendLine(event.taskId, event.clarification.choices.map((choice) => `${chalk.hex(THEME.accent)('•')} ${choice}`).join('\n'));
      }
      renderAll();
      return;
    }

    if (event.type === 'task_done') {
      const task = master.getTask(event.taskId);
      if (task) ensureTaskView(task);
      const view = tasks.get(event.taskId);
      if (view?.stream.trim()) {
        view.lines.push(renderMarkdown(view.stream, 96));
        view.stream = '';
      }
      appendLine(
        event.taskId,
        event.status === 'completed'
          ? chalk.bold.hex(THEME.success)('Done.')
          : chalk.bold.hex(THEME.danger)(`Failed: ${event.result}`),
      );
      if (event.status === 'completed') {
        history.push({ role: 'assistant', content: event.result });
        void saveHistory();
      }
      renderAll();
    }
  });

  const handleCtrlC = (): void => {
    if (!exiting) {
      exiting = true;
      if (modelPickerOpen) closeModelPicker();
      logSystem(chalk.hex(THEME.textMuted)('Press Ctrl+C again to exit.'));
      renderAll();
      return;
    }
    shutdown();
    process.exit(0);
  };

  const setPromptValue = (value: string): void => {
    inputBox.setValue(value);
    resizePrompt();
    inputBox.focus();
    screen.render();
  };

  const togglePlanMode = (): void => {
    mode = mode === 'plan' ? 'execute' : 'plan';
    renderAll();
  };

  const scrollOutput = (offset: number): void => {
    followOutput = false;
    outputScrollOffset = Math.max(0, outputScrollOffset + offset);
    applyOutputScroll();
    inputBox.focus();
    screen.render();
  };

  const scrollOutputTo = (position: 'top' | 'bottom'): void => {
    followOutput = position === 'bottom';
    outputScrollOffset = position === 'top' ? 0 : outputBox.getScrollHeight();
    applyOutputScroll();
    inputBox.focus();
    screen.render();
  };

  const rawInput = screen.program.input as NodeJS.ReadStream;
  const terminalOutput = screen.program.output as NodeJS.WriteStream;
  let rawInputBuffer = '';
  let suppressedInputTail = '';
  terminalOutput.write(ENABLE_ENHANCED_KEYS);
  const handleRawInput = (data: Buffer | string): void => {
    rawInputBuffer = `${rawInputBuffer}${data.toString('utf8')}`.slice(-64);
    const ctrlCSequence = CTRL_C_SEQUENCES.find((candidate) => rawInputBuffer.includes(candidate));
    if (ctrlCSequence) {
      suppressedInputTail += printableTailForSequences(rawInputBuffer, CTRL_C_SEQUENCES);
      rawInputBuffer = '';
      handleCtrlC();
      return;
    }
    if (modelPickerOpen || exiting) return;
    const sequence = SHIFT_ENTER_SEQUENCES.find((candidate) => rawInputBuffer.includes(candidate));
    if (!sequence) return;
    suppressedInputTail = printableShiftEnterTail(sequence);
    rawInputBuffer = '';
    setPromptValue(`${inputBox.getValue()}\n`);
  };
  rawInput.prependListener('data', handleRawInput);

  screen.program.on('keypress', (ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg) => {
    if (suppressedInputTail && ch === suppressedInputTail[0]) {
      suppressedInputTail = suppressedInputTail.slice(1);
      return;
    }

    if (key.ctrl && key.name === 'c') {
      handleCtrlC();
      return;
    }

    if (modelPickerOpen) {
      if (key.name === 'up' || ch === 'k') {
        moveModelPicker(-1);
        return;
      }
      if (key.name === 'down' || ch === 'j') {
        moveModelPicker(1);
        return;
      }
      if (key.name === 'enter') {
        chooseModelPickerSelection();
        return;
      }
      if (key.name === 'escape' || ch === 'q') {
        closeModelPicker();
        return;
      }
      return;
    }

    if (key.shift && key.name === 'tab') {
      togglePlanMode();
      return;
    }

    if (key.name === 'pageup') {
      scrollOutput(-Math.max(1, Math.floor((process.stdout.rows ?? 24) * 0.75)));
      return;
    }
    if (key.name === 'pagedown') {
      scrollOutput(Math.max(1, Math.floor((process.stdout.rows ?? 24) * 0.75)));
      return;
    }
    if (key.name === 'home') {
      scrollOutputTo('top');
      return;
    }
    if (key.name === 'end') {
      scrollOutputTo('bottom');
      return;
    }
    if (key.name === 'up') {
      scrollOutput(-1);
      return;
    }
    if (key.name === 'down') {
      scrollOutput(1);
      return;
    }
    if (key.ctrl && key.name === 'u') {
      return;
    }
    if (key.ctrl && key.name === 'd') {
      return;
    }

    if (exiting) exiting = false;

    if (key.name === 'enter') {
      if (key.shift) {
        setPromptValue(`${inputBox.getValue()}\n`);
        return;
      }
      const value = inputBox.getValue();
      setPromptValue('');
      void submitPrompt(value);
      return;
    }
    if (key.name === 'escape') {
      setPromptValue('');
      return;
    }
    if (key.name === 'backspace') {
      setPromptValue(Array.from(inputBox.getValue()).slice(0, -1).join(''));
      return;
    }
    if (ch && !/^[\x00-\x08\x0b-\x1f\x7f]$/.test(ch)) {
      setPromptValue(inputBox.getValue() + ch);
    }
  });

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    exiting = true;
    stopSendAnimation();
    rawInput.removeListener('data', handleRawInput);
    terminalOutput.write(DISABLE_ENHANCED_KEYS);
    unsubscribe();
  };

  const shutdown = (): void => {
    cleanup();
    closeModelPicker();
    promptReadState.pending = false;
    try {
      inputBox.removeAllListeners('blur');
      inputBox.removeAllListeners('cancel');
      inputBox.removeAllListeners('submit');
    } catch {
      // ignore
    }
    try {
      screen.program.showCursor();
      screen.program.disableMouse();
    } catch {
      // ignore
    }
    try {
      if (typeof screen.leave === 'function') {
        screen.leave();
      }
    } catch {
      // ignore
    }
    try {
      screen.destroy();
    } catch {
      // ignore
    }
  };

  ensurePromptReading(inputBox, modelPickerOpen, exiting, promptReadState);
  renderAll();
}
