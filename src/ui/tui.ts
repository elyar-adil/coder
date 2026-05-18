/**
 * Minimal blessed TUI: one readable master output stream and one prompt input.
 */

import blessed from 'blessed';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';

import { renderMarkdown } from '../markdown.js';
import { ConversationStore, type ConversationEntry } from '../store.js';
import type { MasterCoordinator } from '../runtime/coordinator.js';
import type { ClarificationRequest, PromptTask, TaskMode, TaskPhase } from '../domain/task.js';

const PHASE_LABELS: Record<TaskPhase, string> = {
  plan: 'Planning',
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
  lines: string[];
  stream: string;
  status: string;
  updatedAt: string;
};

type StatusSnapshot = {
  usedTokens: number;
  totalTokens: number;
  remainingTokens: number;
  remainingRatio: number;
};

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

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function inferContextWindow(modelName: string): number {
  const normalized = modelName.toLowerCase();
  const match = normalized.match(/(\d{2,3})k/);
  if (match?.[1]) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 1000;
  }
  if (/128k/.test(normalized)) return 128_000;
  if (/64k/.test(normalized)) return 64_000;
  if (/32k/.test(normalized)) return 32_000;
  if (/16k/.test(normalized)) return 16_000;
  if (/8k/.test(normalized)) return 8_000;
  return 32_000;
}

function renderTask(view: TaskView): string {
  const body = [...view.lines];
  if (view.stream.trim()) body.push(renderMarkdown(view.stream, 96));

  return [
    `${chalk.cyan('➤')} ${chalk.bold.cyan(view.title)}`,
    `${chalk.dim('↳')} ${chalk.dim(`You: ${view.prompt}`)}`,
    '',
    ...body.map((line) => (line.trim() ? `${chalk.dim('↳')} ${line}` : line)),
  ].join('\n');
}

function collectStatusSnapshot(tasks: Map<string, TaskView>, modelName: string): StatusSnapshot {
  const totalTokens = inferContextWindow(modelName);
  let usedTokens = 0;
  for (const view of tasks.values()) {
    usedTokens += estimateTokens(view.title);
    usedTokens += estimateTokens(view.prompt);
    usedTokens += estimateTokens(view.lines.join('\n'));
    usedTokens += estimateTokens(view.stream);
  }
  usedTokens = Math.min(usedTokens, totalTokens);
  const remainingTokens = Math.max(0, totalTokens - usedTokens);
  const remainingRatio = totalTokens === 0 ? 0 : remainingTokens / totalTokens;
  return { usedTokens, totalTokens, remainingTokens, remainingRatio };
}

export async function runTui(master: MasterCoordinator, modelName: string): Promise<void> {
  const convStore = new ConversationStore();
  await convStore.init();

  const sessionId = `session-${Date.now()}`;
  const history: ConversationEntry[] = [];
  const tasks = new Map<string, TaskView>();
  const taskOrder: string[] = [];
  let mode: TaskMode = 'execute';
  let activeClarification: ClarificationRequest | undefined;
  let exiting = false;

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    dockBorders: false,
    title: 'Coding Agent',
  });

  const outputBox = blessed.box({
    top: 0,
    left: 0,
    right: 0,
    bottom: 5,
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    style: {
      bg: 'black',
      fg: 'white',
    },
    content: '',
  });

  const inputShell = blessed.box({
    bottom: 1,
    left: 0,
    right: 0,
    height: 3,
    tags: true,
    style: {
      bg: '#102433',
      fg: 'white',
    },
  });

  blessed.box({
    parent: inputShell,
    top: 1,
    left: 1,
    width: 2,
    height: 1,
    tags: true,
    content: chalk.cyan('›'),
    style: {
      bg: '#102433',
      fg: 'cyan',
    },
  });

  const inputBox = blessed.textbox({
    parent: inputShell,
    top: 1,
    left: 3,
    right: 1,
    height: 1,
    tags: true,
    inputOnFocus: true,
    keys: true,
    mouse: true,
    style: {
      bg: '#102433',
      fg: 'white',
      focus: { bg: '#102433', fg: 'white' },
    },
  });

  const statusBox = blessed.box({
    bottom: 0,
    left: 0,
    right: 0,
    height: 1,
    tags: true,
    style: {
      bg: 'black',
      fg: 'gray',
    },
    content: '',
  });

  screen.append(outputBox);
  screen.append(inputShell);
  screen.append(statusBox);

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
        lines: [],
        stream: '',
        status: task.status,
        updatedAt: task.updatedAt ?? new Date().toISOString(),
      };
      tasks.set(task.taskId, view);
      taskOrder.push(task.taskId);
    }
    view.title = titleForTask(task);
    view.prompt = task.prompt;
    view.mode = task.mode;
    view.status = task.status;
    view.updatedAt = task.updatedAt ?? view.updatedAt;
    return view;
  };

  const renderAll = (): void => {
    const chunks = taskOrder
      .map((taskId) => tasks.get(taskId))
      .filter((view): view is TaskView => Boolean(view))
      .map(renderTask);

    const intro = tasks.size === 0
      ? [
          `${chalk.cyan('➤')} ${chalk.dim(`model ${modelName} · mode ${mode}`)}`,
          chalk.dim('Type a prompt. Use /mode execute|plan|react, /clear, /history, or /exit.'),
        ].join('\n')
      : chunks.join('\n\n');

    outputBox.setContent(intro);
    const status = collectStatusSnapshot(tasks, modelName);
    const left = `${chalk.dim(`context ${Math.round(status.remainingRatio * 100)}% left`)} ${chalk.dim(`(${status.usedTokens}/${status.totalTokens})`)}`;
    const right = chalk.dim(`model ${modelName}`);
    const width = Math.max(20, process.stdout.columns ?? 80);
    const gap = Math.max(1, width - stripAnsi(left).length - stripAnsi(right).length);
    statusBox.setContent(`${left}${' '.repeat(gap)}${right}`);
    screen.render();
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
        lines: [],
        stream: '',
        status: 'idle',
        updatedAt: new Date().toISOString(),
      };
      tasks.set(id, view);
      taskOrder.push(id);
    }
    view.lines.push(line);
  };

  const answerClarification = (answer: string): boolean => {
    if (!activeClarification) return false;
    master.answerClarification(activeClarification.taskId, activeClarification.clarificationId, answer);
    appendLine(activeClarification.taskId, chalk.green(`You answered: ${answer}`));
    activeClarification = undefined;
    return true;
  };

  async function handleCommand(line: string): Promise<void> {
    const [cmd = '', ...args] = line.slice(1).trim().split(/\s+/);

    if (cmd === 'exit' || cmd === 'quit') {
      cleanup();
      process.exit(0);
    }

    if (cmd === 'mode') {
      const next = args[0] as TaskMode | undefined;
      if (next === 'execute' || next === 'plan' || next === 'react') {
        mode = next;
        logSystem(chalk.green(`Mode changed to ${mode}.`));
      } else {
        logSystem(chalk.yellow('Usage: /mode execute|plan|react'));
      }
      renderAll();
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
        ? chalk.dim('No conversation history yet.')
        : history.map((entry) => `${entry.role}: ${simplifyText(entry.content, 120)}`).join('\n'));
      renderAll();
      return;
    }

    if (cmd === 'help') {
      logSystem([
        chalk.bold('Commands'),
        '/mode execute|plan|react',
        '/clear',
        '/history',
        '/exit',
      ].join('\n'));
      renderAll();
      return;
    }

    logSystem(chalk.yellow(`Unknown command: /${cmd}`));
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
        chalk.bold('Master'),
        chalk.dim('Preparing the request.'),
      ];
      renderAll();
      return;
    }

    if (event.type === 'task_updated') {
      ensureTaskView(event.task);
      renderAll();
      return;
    }

    if (event.type === 'task_phase') {
      appendLine(event.taskId, chalk.yellow(phaseText(event.phase, event.note)));
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
        appendLine(event.taskId, chalk.yellow(`Editing code: ${simplifyText(event.input, 100)}`));
      } else if (event.tool === 'bash') {
        appendLine(event.taskId, chalk.dim(`Running: ${simplifyText(event.input, 120)}`));
      } else if (event.tool !== 'read_file' && event.tool !== 'list_dir') {
        appendLine(event.taskId, chalk.dim(`Using ${event.tool}.`));
      }
      renderAll();
      return;
    }

    if (event.type === 'tool_result') {
      if (event.tool === 'write_file' || event.tool === 'edit_file') {
        appendLine(event.taskId, renderMarkdown(event.output, 96));
      } else if (event.tool === 'bash') {
        appendLine(event.taskId, chalk.dim(simplifyText(event.output.split('\n')[0] ?? '', 160)));
      }
      renderAll();
      return;
    }

    if (event.type === 'clarification_requested') {
      activeClarification = event.clarification;
      appendLine(event.taskId, chalk.yellow(`Question: ${event.clarification.question}`));
      if (event.clarification.choices.length > 0) {
        appendLine(event.taskId, event.clarification.choices.map((choice) => `- ${choice}`).join('\n'));
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
          ? chalk.green('Done.')
          : chalk.red(`Failed: ${event.result}`),
      );
      if (event.status === 'completed') {
        history.push({ role: 'assistant', content: event.result });
        void saveHistory();
      }
      renderAll();
    }
  });

  inputBox.on('submit', (value: string) => {
    inputBox.clearValue();
    void submitPrompt(value);
  });

  screen.key(['C-c'], () => {
    if (!exiting) {
      exiting = true;
      logSystem(chalk.dim('Press Ctrl+C again to exit.'));
      renderAll();
      return;
    }
    cleanup();
    process.exit(0);
  });

  const flushTimer = setInterval(renderAll, 120);
  flushTimer.unref?.();

  const cleanup = (): void => {
    exiting = true;
    clearInterval(flushTimer);
    unsubscribe();
    try {
      screen.destroy();
    } catch {
      // ignore
    }
  };

  inputBox.focus();
  renderAll();
}
