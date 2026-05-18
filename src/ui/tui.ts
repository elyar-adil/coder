/**
 * Async task-panel TUI.
 *
 * The interface is intentionally non-blocking:
 * - user prompts are submitted immediately
 * - background task updates stream into the panel
 * - clarification requests are routed through the master only
 */

import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

import chalk from 'chalk';
import ora from 'ora';

import { renderMarkdown } from '../markdown.js';
import { ConversationStore, type ConversationEntry } from '../store.js';
import type { MasterCoordinator } from '../runtime/coordinator.js';
import type { ClarificationRequest, PromptTask, TaskMode } from '../domain/task.js';

const ICONS = {
  user: chalk.cyan('❯'),
  agent: chalk.magenta('◆'),
  phase: chalk.yellow('◈'),
  ok: chalk.green('✔'),
  fail: chalk.red('✘'),
  info: chalk.blue('ℹ'),
  warn: chalk.yellow('⚠'),
  tool: chalk.blue('⚙'),
  result: chalk.dim('↳'),
};

const PHASE_LABELS: Record<string, string> = {
  plan: 'Planning',
  design: 'Designing',
  inspect_code: 'Inspecting',
  write_code: 'Writing',
  verify: 'Verifying',
  finalize: 'Finalizing',
};

function hr(char = '─', width?: number): string {
  return chalk.dim(char.repeat(width ?? (process.stdout.columns || 80)));
}

function printHeader(): void {
  const width = process.stdout.columns || 80;
  const title = ' Coding Agent ';
  const pad = Math.max(0, Math.floor((width - title.length) / 2));
  const right = Math.max(0, width - pad - title.length);
  console.log('\n' + chalk.dim('─'.repeat(pad)) + chalk.bold.cyan(title) + chalk.dim('─'.repeat(right)));
}

function printStatusBar(model: string, mode: TaskMode): void {
  const width = process.stdout.columns || 80;
  const left = chalk.dim('model: ') + chalk.white(model);
  const right = chalk.dim('mode: ') + chalk.white(mode);
  const gap = Math.max(1, width - (model.length + 7) - (mode.length + 6));
  process.stdout.write(hr() + '\n');
  process.stdout.write(left + ' '.repeat(gap) + right + '\n');
  process.stdout.write(hr() + '\n');
}

function buildPromptStr(mode: TaskMode): string {
  const arrow = mode === 'execute' ? '\x1b[36m❯\x1b[0m' : mode === 'plan' ? '\x1b[33m❯\x1b[0m' : '\x1b[35m❯\x1b[0m';
  return `\n${arrow} `;
}

function showTaskLine(task: PromptTask): void {
  const statusColor = task.status === 'completed' ? chalk.green
    : task.status === 'failed' ? chalk.red
    : task.status === 'running' ? chalk.yellow
    : task.status === 'waiting_user' ? chalk.magenta
    : chalk.dim;
  const pending = (task.pendingClarifications ?? []).filter((item) => item.status === 'pending').length;
  const extra = pending > 0 ? chalk.magenta(`  pending:${pending}`) : '';
  console.log(`  ${chalk.dim(task.taskId.slice(0, 8))}  ${chalk.white(task.mode.padEnd(8))}  ${statusColor(task.status.padEnd(12))}${extra}  ${chalk.dim(task.prompt.slice(0, 48))}`);
}

function showTaskDetails(task: PromptTask): void {
  console.log(hr());
  console.log(chalk.bold('Task:   ') + chalk.white(task.taskId));
  console.log(chalk.bold('Mode:   ') + task.mode + '   ' + chalk.bold('Status: ') + task.status);
  console.log(chalk.bold('Prompt: ') + chalk.dim(task.prompt.slice(0, 200)));
  if (task.planner) {
    console.log(chalk.bold('\nPlanner:'));
    console.log(chalk.dim(task.planner.summary));
  }
  if (task.plan.length > 0) {
    console.log(chalk.bold('\nPlan:'));
    task.plan.forEach((step, index) => {
      console.log(`  ${chalk.cyan(String(index + 1) + '.')} ${step.title} — ${chalk.dim(step.detail)}`);
    });
  }
  if ((task.pendingClarifications ?? []).length > 0) {
    console.log(chalk.bold('\nClarifications:'));
    task.pendingClarifications?.forEach((item) => {
      const state = item.status === 'pending' ? chalk.magenta('pending') : chalk.green('answered');
      console.log(`  ${chalk.dim(item.clarificationId.slice(0, 8))} ${state} ${chalk.dim(item.question)}`);
    });
  }
  if (task.sharedContext) {
    console.log(chalk.bold('\nShared context:'));
    console.log(chalk.dim(task.sharedContext.slice(0, 800)));
  }
  if (task.result) {
    console.log(chalk.bold('\nResult:'));
    console.log(renderMarkdown(task.result, process.stdout.columns || 80));
  }
  console.log(hr());
}

function printHelp(): void {
  console.log(`
${chalk.bold('Commands')}
  ${chalk.cyan('/mode <execute|plan|react>')}   Switch agent mode
  ${chalk.cyan('/clear')}                       Clear conversation history
  ${chalk.cyan('/history')}                     Show conversation history
  ${chalk.cyan('/tasks')}                       List all background tasks
  ${chalk.cyan('/inbox')}                       List pending clarifications
  ${chalk.cyan('/subagents')}                   List sub-agents
  ${chalk.cyan('/view <taskId>')}               Inspect a task
  ${chalk.cyan('/approve <taskId>')}            Execute an approved plan task
  ${chalk.cyan('/model')}                       Show current model
  ${chalk.cyan('/resume <taskId>')}             Resume a queued/running task
  ${chalk.cyan('/sessions')}                    List saved conversation sessions
  ${chalk.cyan('/load <sessionId>')}            Load a saved conversation
  ${chalk.cyan('/help')}                        Show this help
  ${chalk.cyan('/exit')}  or  ${chalk.cyan('Ctrl+C')}            Quit

${chalk.bold('Modes')}
  ${chalk.white('execute')}   Background coding task ${chalk.dim('(default)')}
  ${chalk.white('plan')}      Generate a plan first, then approve
  ${chalk.white('react')}     Plan → inspect → write → verify
`);
}

async function promptQuestion(rl: readline.Interface, question: string): Promise<string> {
  return new Promise<string>((resolve) => {
    rl.question(chalk.cyan(`  ${question} `) + '> ', (answer) => resolve(answer.trim()));
  });
}

export async function runTui(master: MasterCoordinator, modelName: string): Promise<void> {
  const rl = readline.createInterface({
    input,
    output,
    terminal: true,
    historySize: 200,
    prompt: '',
  });

  let mode: TaskMode = 'execute';
  let exiting = false;
  const pendingClarifications: ClarificationRequest[] = [];
  const history: ConversationEntry[] = [];

  const convStore = new ConversationStore();
  await convStore.init();
  const sessionId = `session-${Date.now()}`;

  const saveHistory = async (): Promise<void> => {
    await convStore.save(sessionId, history);
  };

  const redrawPrompt = (): void => {
    rl.setPrompt(buildPromptStr(mode));
    rl.prompt(true);
  };

  const unsubscribe = master.subscribe((event) => {
    if (event.type === 'task_created') {
      console.log(`${ICONS.info} queued ${chalk.white(event.task.taskId.slice(0, 8))} ${chalk.dim(event.task.prompt.slice(0, 72))}`);
      redrawPrompt();
      return;
    }

    if (event.type === 'task_phase') {
      const label = PHASE_LABELS[event.phase] ?? event.phase;
      const note = event.note ? chalk.dim(` · ${event.note}`) : '';
      if (event.status === 'in_progress') {
        console.log(`\n${ICONS.phase} ${chalk.yellow(label)}${note}`);
      } else if (event.status === 'done') {
        console.log(`${ICONS.ok} ${chalk.green(label)}${note}`);
      } else if (event.status === 'failed') {
        console.log(`${ICONS.fail} ${chalk.red(label)}${note}`);
      }
      redrawPrompt();
      return;
    }

    if (event.type === 'task_output') {
      console.log(renderMarkdown(event.text, process.stdout.columns || 80));
      redrawPrompt();
      return;
    }

    if (event.type === 'tool_call') {
      console.log(`${ICONS.tool} ${chalk.blue(event.tool)} ${chalk.dim(event.input.slice(0, 60))}`);
      redrawPrompt();
      return;
    }

    if (event.type === 'tool_result') {
      const firstLine = event.output.split('\n')[0] ?? '';
      const preview = firstLine.length > 70 ? `${firstLine.slice(0, 67)}…` : firstLine;
      console.log(`${ICONS.result} ${chalk.dim(preview)}`);
      redrawPrompt();
      return;
    }

    if (event.type === 'clarification_requested') {
      const request = event.clarification;
      const isTyping = Boolean(rl.line && rl.line.trim().length > 0);
      if (isTyping) {
        pendingClarifications.push(request);
        console.log(`\n${ICONS.warn} ${chalk.yellow('Queued clarification:')} ${chalk.dim(request.question)}`);
        redrawPrompt();
        return;
      }
      void handleClarification(request);
      return;
    }

    if (event.type === 'clarification_answered') {
      console.log(`${ICONS.ok} ${chalk.green('Clarification answered')} ${chalk.dim(event.clarificationId.slice(0, 8))}`);
      redrawPrompt();
      return;
    }

    if (event.type === 'task_done') {
      const task = master.getTask(event.taskId);
      if (task?.result) {
        history.push({ role: 'assistant', content: task.result });
        void saveHistory();
      }
      const icon = event.status === 'completed' ? ICONS.ok : ICONS.fail;
      const color = event.status === 'completed' ? chalk.green : chalk.red;
      console.log(`${icon} ${color(`Task ${event.status}`)} ${chalk.dim(event.taskId.slice(0, 8))}`);
      redrawPrompt();
    }
  });

  async function drainClarifications(): Promise<void> {
    while (pendingClarifications.length > 0 && (!rl.line || rl.line.trim().length === 0)) {
      const request = pendingClarifications.shift()!;
      // eslint-disable-next-line no-await-in-loop
      await handleClarification(request);
    }
  }

  async function handleClarification(request: ClarificationRequest): Promise<void> {
    console.log(`\n${ICONS.warn} ${chalk.yellow('Master asks:')} ${request.question}`);
    const answer = await promptQuestion(rl, 'Your answer');
    master.answerClarification(request.taskId, request.clarificationId, answer);
    console.log(`${ICONS.ok} ${chalk.dim('Answer sent to master')}`);
    redrawPrompt();
  }

  async function handleCommand(line: string): Promise<void> {
    const parts = line.slice(1).split(' ');
    const cmd = parts[0] ?? '';
    const args = parts.slice(1);

    if (cmd === 'exit' || cmd === 'quit') {
      exiting = true;
      rl.close();
      return;
    }

    if (cmd === 'help') {
      printHelp();
      return;
    }

    if (cmd === 'mode') {
      const nextMode = args[0] as TaskMode | undefined;
      if (!nextMode || !['execute', 'plan', 'react'].includes(nextMode)) {
        console.log(`${ICONS.warn} Valid modes: ${chalk.white('execute')}, ${chalk.white('plan')}, ${chalk.white('react')}`);
      } else {
        mode = nextMode;
        console.log(`${ICONS.ok} Mode → ${chalk.white(mode)}`);
        printStatusBar(modelName, mode);
      }
      return;
    }

    if (cmd === 'clear') {
      history.length = 0;
      await convStore.remove(sessionId);
      console.clear();
      printHeader();
      printStatusBar(modelName, mode);
      console.log(`${ICONS.ok} Conversation cleared.`);
      return;
    }

    if (cmd === 'history') {
      if (history.length === 0) {
        console.log(chalk.dim('  (no history yet)'));
      } else {
        console.log(hr());
        for (const msg of history) {
          const icon = msg.role === 'user' ? ICONS.user : ICONS.agent;
          const label = msg.role === 'user' ? chalk.cyan('You') : chalk.magenta('Agent');
          const preview = msg.content.slice(0, 120).replace(/\n/g, ' ');
          const ellipsis = msg.content.length > 120 ? chalk.dim('…') : '';
          console.log(`${icon} ${label}: ${chalk.dim(preview)}${ellipsis}`);
        }
        console.log(hr());
      }
      return;
    }

    if (cmd === 'tasks') {
      const tasks = master.listTasks();
      if (tasks.length === 0) {
        console.log(chalk.dim('  (no tasks)'));
      } else {
        console.log(hr());
        tasks.forEach(showTaskLine);
        console.log(hr());
      }
      return;
    }

    if (cmd === 'inbox') {
      const requests = master.listPendingClarifications();
      if (requests.length === 0) {
        console.log(chalk.dim('  (empty inbox)'));
      } else {
        console.log(hr());
        requests.forEach((request) => {
          console.log(`  ${chalk.dim(request.clarificationId.slice(0, 8))}  ${chalk.white(request.taskId.slice(0, 8))}  ${chalk.yellow(request.question)}`);
        });
        console.log(hr());
      }
      return;
    }

    if (cmd === 'subagents') {
      const subs = master.listSubagents();
      if (subs.length === 0) {
        console.log(chalk.dim('  (no sub-agents)'));
      } else {
        console.log(hr());
        for (const sub of subs) {
          const color = sub.status === 'completed' ? chalk.green : sub.status === 'failed' ? chalk.red : chalk.yellow;
          console.log(`  ${chalk.dim(sub.taskId.slice(0, 8))}  ${color(sub.status.padEnd(10))}  ${chalk.dim(sub.prompt.slice(0, 60))}`);
        }
        console.log(hr());
      }
      return;
    }

    if (cmd === 'view') {
      const id = args[0];
      if (!id) {
        console.log(`${ICONS.warn} Usage: /view <taskId>`);
        return;
      }
      const task = master.getTask(id);
      if (!task) {
        console.log(`${ICONS.fail} Task not found: ${id}`);
        return;
      }
      showTaskDetails(task);
      return;
    }

    if (cmd === 'approve') {
      const id = args[0];
      if (!id) {
        console.log(`${ICONS.warn} Usage: /approve <taskId>`);
        return;
      }
      const spinner = ora({ text: 'Executing plan…', color: 'cyan' }).start();
      const ok = await master.executePlan(id);
      spinner.stop();
      console.log(ok
        ? `${ICONS.ok} Plan execution started for ${chalk.white(id)}`
        : `${ICONS.fail} Could not execute — task not found or not in plan mode`);
      return;
    }

    if (cmd === 'model') {
      console.log(`${ICONS.info} Model: ${chalk.white(modelName)}`);
      return;
    }

    if (cmd === 'resume') {
      const id = args[0];
      if (!id) {
        console.log(`${ICONS.warn} Usage: /resume <taskId>`);
        return;
      }
      const task = master.getTask(id);
      if (!task) {
        console.log(`${ICONS.fail} Task not found: ${id}`);
        return;
      }
      if (task.status === 'completed' || task.status === 'failed') {
        console.log(`${ICONS.info} Task already ${task.status}. Use /view ${id} to see result.`);
        return;
      }
      const ok = await master.resolveTask(id);
      console.log(ok ? `${ICONS.ok} Resuming task ${chalk.white(id)}` : `${ICONS.fail} Cannot resume task`);
      return;
    }

    if (cmd === 'sessions') {
      const sessions = await convStore.list();
      if (sessions.length === 0) {
        console.log(chalk.dim('  (no saved sessions)'));
      } else {
        console.log(hr());
        for (const session of sessions.slice(0, 10)) {
          const ts = new Date(session.modified).toLocaleString();
          console.log(`  ${chalk.dim(session.id)}  ${chalk.white(session.entries + ' msgs')}  ${chalk.dim(ts)}`);
        }
        console.log(hr());
      }
      return;
    }

    if (cmd === 'load') {
      const id = args[0];
      if (!id) {
        console.log(`${ICONS.warn} Usage: /load <sessionId>`);
        return;
      }
      const loaded = await convStore.load(id);
      if (loaded.length === 0) {
        console.log(`${ICONS.fail} Session not found or empty: ${id}`);
      } else {
        history.length = 0;
        history.push(...loaded);
        console.log(`${ICONS.ok} Loaded ${chalk.white(loaded.length)} messages from ${chalk.dim(id)}`);
      }
      return;
    }

    console.log(`${ICONS.warn} Unknown command: ${chalk.white('/' + cmd)}. Type ${chalk.cyan('/help')}.`);
  }

  async function handleLine(line: string): Promise<void> {
    const userInput = line.trim();
    if (!userInput) {
      await drainClarifications();
      redrawPrompt();
      return;
    }

    if (userInput.startsWith('/')) {
      await handleCommand(userInput);
      await drainClarifications();
      redrawPrompt();
      return;
    }

    history.push({ role: 'user', content: userInput });
    await saveHistory();
    const taskId = await master.acceptPrompt('tui-user', userInput, mode, history.slice(0, -1));
    console.log(`${ICONS.ok} ${chalk.green('Queued')} ${chalk.dim(taskId.slice(0, 8))}`);
    redrawPrompt();
  }

  rl.on('SIGINT', () => {
    if (exiting) {
      rl.close();
      process.exit(0);
    }
    exiting = true;
    process.stdout.write(`\n${ICONS.info} ${chalk.dim('Press Ctrl+C again to exit.')}\n`);
    setTimeout(() => {
      exiting = false;
    }, 2000);
    redrawPrompt();
  });

  rl.on('close', () => {
    unsubscribe();
    if (input.isTTY) input.setRawMode(false);
    input.off('keypress', onKeypress);
  });

  readline.emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);
  const onKeypress = (_str: string, key: { name?: string; meta?: boolean; shift?: boolean; ctrl?: boolean; sequence?: string }): void => {
    if (key?.ctrl && key.name === 'c') return;
    const isShiftTab = (key?.name === 'tab' && key?.shift) || key?.sequence === '\x1b[Z';
    if (isShiftTab) {
      mode = mode === 'plan' ? 'execute' : 'plan';
      console.log(`\n${ICONS.ok} Mode → ${chalk.white(mode)} ${chalk.dim(mode === 'plan' ? '(planning only; no file modifications)' : '')}`);
      printStatusBar(modelName, mode);
      redrawPrompt();
    }
  };
  input.on('keypress', onKeypress);

  rl.on('line', (line) => {
    void handleLine(line);
  });

  printHeader();
  console.log(chalk.dim(`  Type your prompt and press Enter. Use ${chalk.white('/help')} for commands.\n`));
  printStatusBar(modelName, mode);
  console.log(`${ICONS.ok} ${chalk.green('Ready')} — ${chalk.dim('model:')} ${chalk.white(modelName)}  ${chalk.dim('mode:')} ${chalk.white(mode)}`);
  redrawPrompt();
}
