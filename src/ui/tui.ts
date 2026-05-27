/**
 * Stream-style TUI: logs scroll naturally, fixed input bar at bottom.
 * Architecture: raw stdout for all output (terminal handles scrolling),
 * readline for input bar pinned to last line.
 */

import * as readline from 'node:readline';
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
  status: TaskStatus | string;
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

function formatTimestamp(value?: string): string {
  if (!value) return '--:--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function statusColor(status: TaskStatus | string): string {
  switch (status) {
    case 'completed': return THEME.success;
    case 'failed': return THEME.danger;
    case 'blocked':
    case 'waiting_user': return THEME.warning;
    case 'running': return THEME.accentStrong;
    default: return THEME.textMuted;
  }
}

function modeColor(taskMode: TaskMode): string {
  return taskMode === 'plan' ? THEME.planAccentStrong : THEME.accentStrong;
}

const STATUS_ICON: Record<string, string> = {
  completed: '✓',
  failed: '✗',
  running: '⟳',
  waiting_user: '?',
  blocked: '⚠',
  queued: '·',
};

// ── Stdout helpers ──────────────────────────────────────────────────────────

// ── Summary bar ─────────────────────────────────────────────────────────────

function renderSummaryBar(tasks: Map<string, TaskView>, taskOrder: string[]): string {
  const cols = process.stdout.columns ?? 80;
  const userTaskIds = taskOrder.filter((id) => id !== '__system__');
  if (userTaskIds.length === 0) return '';

  const parts = userTaskIds.map((id) => {
    const view = tasks.get(id);
    if (!view) return '';
    const icon = STATUS_ICON[view.status] ?? '·';
    const colored = chalk.hex(statusColor(view.status))(icon);
    const title = chalk.hex(THEME.textSoft)(simplifyText(view.title, 18));
    return `${colored} ${title}`;
  }).filter(Boolean);

  const bar = parts.join(chalk.hex(THEME.textMuted)('  ·  '));
  const label = chalk.hex(THEME.textMuted)('tasks: ');
  const raw = stripAnsi(label + bar);
  if (raw.length <= cols) return label + bar;
  // Avoid slicing ANSI-colored text, which can break terminal escape sequences.
  return `${label}${chalk.hex(THEME.textMuted)('…')}`;
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
  let streamBuffers = new Map<string, string>(); // taskId -> pending stream text
  const lastTaskHeadline = new Map<string, string>();

  // ── readline setup ────────────────────────────────────────────────────────

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: '',
  });

  const out = process.stdout;

  function renderPrompt(): void {
    const modeCol = chalk.hex(modeColor(mode))(mode);
    const clarification = activeClarification ? chalk.hex(THEME.warning)(' [answering question]') : '';
    const promptLine = `${chalk.hex(THEME.textMuted)('[')}${modeCol}${chalk.hex(THEME.textMuted)(']')}${clarification} ${chalk.hex(THEME.accent)('›')} `;
    rl.setPrompt(promptLine);
    rl.prompt(true);
  }

  function log(line: string): void {
    readline.clearLine(out, 0);
    readline.cursorTo(out, 0);
    out.write(`${line}\n`);
    renderPrompt();
  }

  // ── Task state ────────────────────────────────────────────────────────────

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
        pendingMailboxUpdates: (task.mailbox ?? []).filter((m) => m.status === 'pending').length,
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
    view.pendingMailboxUpdates = (task.mailbox ?? []).filter((m) => m.status === 'pending').length;
    view.llmTrace = task.llmTrace ?? [];
    view.status = task.status;
    view.updatedAt = task.updatedAt ?? view.updatedAt;
    return view;
  };

  const taskPrefix = (view: TaskView): string => {
    const icon = chalk.hex(statusColor(view.status))(STATUS_ICON[view.status] ?? '·');
    const title = chalk.bold.hex(THEME.accent)(simplifyText(view.title, 72));
    return `${icon} ${title}`;
  };

  // ── Stream output: buffer per task, flush on newline ──────────────────────

  const flushStream = (taskId: string): void => {
    const buf = streamBuffers.get(taskId) ?? '';
    if (!buf.trim()) return;
    const view = tasks.get(taskId);
    const prefix = view ? taskPrefix(view) : taskId;
    for (const line of buf.split('\n')) {
      if (line.trim()) {
        log(`  ${chalk.hex(THEME.textMuted)('│')} ${line}`);
      }
    }
    streamBuffers.set(taskId, '');
    if (view) {
      view.stream = '';
      view.lines.push(buf);
      view.lines = view.lines.slice(-500);
    }
  };

  const appendStream = (taskId: string, text: string): void => {
    const view = tasks.get(taskId);
    if (!view) return;
    const buf = (streamBuffers.get(taskId) ?? '') + text;
    streamBuffers.set(taskId, buf);
    view.stream = buf;

    // Flush complete lines immediately
    const lines = buf.split('\n');
    if (lines.length > 1) {
      const complete = lines.slice(0, -1);
      const remainder = lines[lines.length - 1] ?? '';
      const prefix = taskPrefix(view);
      for (const line of complete) {
        if (line.trim()) {
          log(`  ${chalk.hex(THEME.textMuted)('│')} ${line}`);
        }
      }
      streamBuffers.set(taskId, remainder);
      view.stream = remainder;
      view.lines.push(...complete.filter((l) => l.trim()));
      view.lines = view.lines.slice(-500);
    }
  };

  const appendLine = (taskId: string, line: string): void => {
    flushStream(taskId);
    const view = tasks.get(taskId);
    if (!view) return;
    log(line);
    view.lines.push(line);
    view.lines = view.lines.slice(-500);
  };

  const logSystem = (line: string): void => {
    log(chalk.hex(THEME.textMuted)(line));
  };

  // ── Commands ──────────────────────────────────────────────────────────────

  const saveHistory = async (): Promise<void> => {
    await convStore.save(sessionId, history);
  };

  const applyModelSelection = async (requested: string): Promise<void> => {
    if (!resolveModel) {
      logSystem('/model switching is not configured for this session.');
      return;
    }
    try {
      const next = resolveModel(requested);
      master.setBackendConfig(next.config);
      activeModelName = next.name;
      if (persistModelSelection) await persistModelSelection(requested);
      log(chalk.hex(THEME.success)(`Model changed to ${activeModelName}.`));
      if (process.env.AGENT_MODEL) {
        log(chalk.hex(THEME.warning)(`AGENT_MODEL=${process.env.AGENT_MODEL} is set and will override on restart.`));
      }
    } catch (error) {
      log(chalk.hex(THEME.danger)(error instanceof Error ? error.message : String(error)));
    }
    renderPrompt();
  };

  const clarificationChoices = (): string[] => activeClarification?.choices ?? [];

  const answerClarification = (answer: string): boolean => {
    if (!activeClarification) return false;
    const trimmed = answer.trim();
    const choices = clarificationChoices();
    const selected = choices[Number(trimmed) - 1] ?? choices.find((choice) => choice === trimmed);
    if (!selected) {
      log(chalk.hex(THEME.warning)('Choose one of the listed options by number.'));
      return false;
    }
    const accepted = master.answerClarification(activeClarification.taskId, activeClarification.clarificationId, selected);
    if (!accepted) {
      log(chalk.hex(THEME.warning)('That option is no longer available.'));
      activeClarification = undefined;
      renderPrompt();
      return false;
    }
    log(chalk.hex(THEME.success)(`Selected: ${selected}`));
    activeClarification = undefined;
    renderPrompt();
    return true;
  };

  async function handleCommand(line: string): Promise<void> {
    const [cmd = '', ...args] = line.slice(1).trim().split(/\s+/);

    if (cmd === 'exit' || cmd === 'quit') {
      shutdown();
      process.exit(0);
    }

    if (cmd === 'plan') {
      mode = mode === 'plan' ? 'execute' : 'plan';
      log(chalk.hex(THEME.textMuted)(`Mode: ${mode}`));
      renderPrompt();
      return;
    }

    if (cmd === 'mode') {
      const next = args[0] as TaskMode | undefined;
      if (next === 'execute' || next === 'plan' || next === 'react') {
        mode = next;
        log(chalk.hex(THEME.textMuted)(`Mode: ${next}`));
      } else {
        logSystem('Usage: /mode execute|plan|react');
      }
      renderPrompt();
      return;
    }

    if (cmd === 'model') {
      const requested = args[0];
      if (!requested) {
        // Simple inline list picker
        if (modelAliases.length === 0) {
          logSystem('No configured model aliases. Add entries to .agentrc "models".');
          return;
        }
        log(chalk.bold.hex(THEME.accentStrong)('Available models:'));
        modelAliases.forEach((alias, i) => {
          const marker = alias === activeModelName ? chalk.hex(THEME.success)('✓') : ' ';
          log(`  ${marker} ${chalk.hex(THEME.text)(alias)}`);
        });
        logSystem('Use /model <name> to switch.');
      } else {
        await applyModelSelection(requested);
      }
      return;
    }

    if (cmd === 'tasks') {
      const userTasks = taskOrder.filter((id) => id !== '__system__');
      if (userTasks.length === 0) {
        logSystem('No tasks yet.');
        return;
      }
      log(chalk.bold.hex(THEME.accentStrong)('Tasks this session:'));
      for (const id of userTasks) {
        const view = tasks.get(id);
        if (!view) continue;
        const icon = chalk.hex(statusColor(view.status))(STATUS_ICON[view.status] ?? '·');
        const title = chalk.bold.hex(THEME.text)(view.title);
        const time = chalk.hex(THEME.textMuted)(formatTimestamp(view.updatedAt));
        log(`  ${icon}  ${title}  ${chalk.hex(THEME.textMuted)(id.slice(0, 8))}  ${time}`);
      }
      return;
    }

    if (cmd === 'clear') {
      tasks.clear();
      taskOrder.length = 0;
      history.length = 0;
      await convStore.remove(sessionId);
      log(chalk.hex(THEME.textMuted)('Session cleared.'));
      renderPrompt();
      return;
    }

    if (cmd === 'history') {
      if (history.length === 0) {
        logSystem('No conversation history yet.');
      } else {
        for (const entry of history) {
          log(`${chalk.hex(THEME.textMuted)(entry.role)}: ${simplifyText(entry.content, 120)}`);
        }
      }
      return;
    }

    if (cmd === 'help') {
      log([
        chalk.bold.hex(THEME.accentStrong)('Commands'),
        `  ${chalk.hex(THEME.accent)('/mode')} execute|plan|react`,
        `  ${chalk.hex(THEME.accent)('/plan')}           — toggle plan/execute`,
        `  ${chalk.hex(THEME.accent)('/model')} [name]  — list or switch model`,
        `  ${chalk.hex(THEME.accent)('/tasks')}          — show all tasks`,
        `  ${chalk.hex(THEME.accent)('/clear')}          — clear session`,
        `  ${chalk.hex(THEME.accent)('/history')}        — conversation history`,
        `  ${chalk.hex(THEME.accent)('/exit')}           — quit`,
      ].join('\n'));
      return;
    }

    if (activeClarification && (/^\d+$/.test(cmd) || cmd === 'answer')) {
      answerClarification(cmd === 'answer' ? args.join(' ') : cmd);
      return;
    }

    logSystem(`Unknown command: /${cmd}`);
    renderPrompt();
  }

  const submitPrompt = async (text: string): Promise<void> => {
    const userInput = text.trim();
    if (!userInput) {
      renderPrompt();
      return;
    }

    if (activeClarification && /^\d+$/.test(userInput)) {
      answerClarification(userInput);
      return;
    }

    if (userInput.startsWith('/')) {
      await handleCommand(userInput);
      return;
    }

    // Immediate feedback
    log(chalk.hex(THEME.textMuted)(`  › ${simplifyText(userInput, 80)}`));
    log(chalk.hex(THEME.textMuted)('  routing request…'));

    history.push({ role: 'user', content: userInput });
    await saveHistory();
    await master.acceptPrompt('tui-user', userInput, mode, history.slice(0, -1), { sessionId });
    renderPrompt();
  };


  const maybeLogTaskHeadline = (task: PromptTask): void => {
    const view = ensureTaskView(task);
    const status = `${STATUS_ICON[view.status] ?? '·'} ${view.status}`;
    const headline = `${status}  ${simplifyText(view.title, 96)}`;
    if (lastTaskHeadline.get(task.taskId) === headline) return;
    lastTaskHeadline.set(task.taskId, headline);
    log(`${chalk.hex(THEME.textMuted)('task')} ${chalk.hex(statusColor(view.status))(status)}  ${chalk.bold.hex(THEME.textSoft)(simplifyText(view.title, 96))}`);
  };

  // ── Event subscription ────────────────────────────────────────────────────

  const unsubscribe = master.subscribe((event) => {
    if (event.type === 'task_created') {
      if (event.task.sessionId && event.task.sessionId !== sessionId) return;
      maybeLogTaskHeadline(event.task);
      renderPrompt();
      return;
    }

    if (event.type === 'task_updated') {
      if (event.task.sessionId && event.task.sessionId !== sessionId) return;
      maybeLogTaskHeadline(event.task);
      renderPrompt();
      return;
    }

    if ('taskId' in event && typeof event.taskId === 'string') {
      const task = master.getTask(event.taskId);
      if (task?.sessionId && task.sessionId !== sessionId) return;
    }

    if (event.type === 'user_visible_message') {
      if (event.sessionId && event.sessionId !== sessionId) return;
      log(renderMarkdown(event.text, 96));
      renderPrompt();
      return;
    }

    if (event.type === 'master_response') {
      return;
    }

    if (event.type === 'task_mailbox_updated') {
      return;
    }

    if (event.type === 'task_phase') {
      return;
    }

    if (event.type === 'task_output') {
      return;
    }

    if (event.type === 'tool_call') {
      return;
    }

    if (event.type === 'tool_result') {
      return;
    }

    if (event.type === 'clarification_requested') {
      activeClarification = event.clarification;
      const choices = clarificationChoices();
      log(chalk.hex(THEME.warning)(event.clarification.question));
      choices.forEach((choice, index) => {
        log(`  ${chalk.hex(THEME.warning)(String(index + 1))}. ${choice}`);
      });
      log(chalk.hex(THEME.textMuted)('Select with the number, for example: 1. You can keep submitting new prompts while this waits.'));
      renderPrompt();
      return;
    }

    if (event.type === 'task_done') {
      const task = master.getTask(event.taskId);
      if (task) ensureTaskView(task);
      flushStream(event.taskId);
      const view = tasks.get(event.taskId);
      const prefix = view ? taskPrefix(view) : event.taskId;
      if (event.status === 'completed') {
        history.push({ role: 'assistant', content: event.result });
        void saveHistory();
      } else {
        log(chalk.hex(THEME.danger)(`Task failed: ${event.result}`));
      }
      renderPrompt();
    }
  });

  // ── Input handling ────────────────────────────────────────────────────────

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on('keypress', (_str, key) => {
    if (!key) return;
    if (key.name === 'tab' && key.shift) {
      mode = mode === 'plan' ? 'execute' : 'plan';
      log(chalk.hex(THEME.textMuted)(`Mode: ${mode}`));
      return;
    }
  });

  // Handle Ctrl+C manually for graceful double-tap exit
  process.on('SIGINT', () => {
    if (!exiting) {
      exiting = true;
      log(chalk.hex(THEME.textMuted)('Press Ctrl+C again to exit.'));
      renderPrompt();
      setTimeout(() => { exiting = false; }, 2000);
      return;
    }
    shutdown();
    process.exit(0);
  });

  rl.on('line', (line) => {
    void submitPrompt(line);
  });

  rl.on('close', () => {
    shutdown();
  });

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    unsubscribe();
  };

  const shutdown = (): void => {
    cleanup();
    try { rl.close(); } catch { /* ignore */ }
  };

  // ── Startup ───────────────────────────────────────────────────────────────

  log([
    chalk.bold.hex(THEME.text)('Coder'),
    chalk.hex(THEME.textMuted)('model'),
    chalk.bold.hex(THEME.model)(activeModelName),
    chalk.hex(THEME.textMuted)('mode'),
    chalk.hex(modeColor(mode))(mode),
    chalk.hex(THEME.textMuted)('— /help for commands'),
  ].join('  '));

  renderPrompt();
}
