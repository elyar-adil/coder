/**
 * tui.ts — Claude Code / Codex-class interactive terminal UI
 *
 * Features:
 *  • Streaming token-by-token output (real-time)
 *  • Agentic tool-call display (read_file / write_file / list_dir / bash)
 *  • Conversation history (multi-turn context)
 *  • Rich colors, icons, phase indicators via chalk
 *  • Animated spinner during model thinking
 *  • Inline markdown rendering (headings, bold, code blocks, lists)
 *  • Input history (↑/↓ arrow keys) — prompt managed by readline so
 *    backspace never eats the prompt prefix
 *  • /commands for meta-operations
 *  • Graceful Ctrl+C handling
 *  • Status bar showing model + mode
 */

import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import ora from 'ora';
import { renderMarkdown } from './markdown.js';
import type { MasterCoordinator } from './master.js';
import type { TaskMode, TaskPhase } from './types.js';

// ── Visual constants ─────────────────────────────────────────────────────────
const ICONS = {
  user:   chalk.cyan('❯'),
  agent:  chalk.magenta('◆'),
  phase:  chalk.yellow('◈'),
  ok:     chalk.green('✔'),
  fail:   chalk.red('✘'),
  info:   chalk.blue('ℹ'),
  warn:   chalk.yellow('⚠'),
  tool:   chalk.blue('⚙'),
  result: chalk.dim('↳'),
};

const TOOL_LABELS: Record<string, string> = {
  read_file:  'Reading',
  write_file: 'Writing',
  list_dir:   'Listing',
  bash:       'Running',
};

const PHASE_LABELS: Record<TaskPhase, string> = {
  plan:         'Planning',
  inspect_code: 'Inspecting',
  write_code:   'Writing',
  verify:       'Verifying',
  finalize:     'Finalizing',
};

function hr(char = '─', width?: number): string {
  return chalk.dim(char.repeat(width ?? (process.stdout.columns || 80)));
}

function printHeader(): void {
  const w = process.stdout.columns || 80;
  const title = ' Coding Agent ';
  const pad   = Math.max(0, Math.floor((w - title.length) / 2));
  const right = Math.max(0, w - pad - title.length);
  console.log('\n' + chalk.dim('─'.repeat(pad)) + chalk.bold.cyan(title) + chalk.dim('─'.repeat(right)));
}

function printStatusBar(model: string, mode: TaskMode): void {
  const w        = process.stdout.columns || 80;
  const left     = chalk.dim('model: ') + chalk.white(model);
  const right    = chalk.dim('mode: ')  + chalk.white(mode);
  const leftLen  = model.length + 7;
  const rightLen = mode.length + 6;
  const gap      = Math.max(1, w - leftLen - rightLen);
  process.stdout.write(hr() + '\n');
  process.stdout.write(left + ' '.repeat(gap) + right + '\n');
  process.stdout.write(hr() + '\n');
}

function showPhase(phase: TaskPhase, status: 'in_progress' | 'done' | 'failed' | 'pending', note?: string): void {
  const label   = PHASE_LABELS[phase] ?? phase;
  const noteStr = note ? chalk.dim(' · ' + note) : '';
  if (status === 'in_progress') {
    process.stdout.write(`\n${ICONS.phase} ${chalk.yellow(label)}${noteStr}\n`);
  } else if (status === 'done') {
    process.stdout.write(`${ICONS.ok} ${chalk.green(label)}${noteStr}\n`);
  } else if (status === 'failed') {
    process.stdout.write(`${ICONS.fail} ${chalk.red(label)}${noteStr}\n`);
  }
}

function showToolCall(tool: string, input: string): void {
  const label = TOOL_LABELS[tool] ?? tool;
  const preview = input.length > 60 ? input.slice(0, 57) + '…' : input;
  process.stdout.write(`${ICONS.tool} ${chalk.blue(label)} ${chalk.dim(preview)}\n`);
}

function showToolResult(_tool: string, output: string): void {
  // Show first line of output as a brief confirmation
  const firstLine = output.split('\n')[0] ?? '';
  const preview   = firstLine.length > 70 ? firstLine.slice(0, 67) + '…' : firstLine;
  const isError   = output.startsWith('Error');
  const icon      = isError ? ICONS.fail : ICONS.result;
  const text      = isError ? chalk.red(preview) : chalk.dim(preview);
  process.stdout.write(`${icon} ${text}\n`);
}

// ── Help ─────────────────────────────────────────────────────────────────────
function printHelp(): void {
  console.log(`
${chalk.bold('Commands')}
  ${chalk.cyan('/mode <execute|plan|react>')}   Switch agent mode
  ${chalk.cyan('/clear')}                       Clear conversation history
  ${chalk.cyan('/history')}                     Show conversation history
  ${chalk.cyan('/tasks')}                       List all background tasks
  ${chalk.cyan('/view <taskId>')}               Inspect a task
  ${chalk.cyan('/approve <taskId>')}            Execute an approved plan task
  ${chalk.cyan('/model')}                       Show current model
  ${chalk.cyan('/help')}                        Show this help
  ${chalk.cyan('/exit')}  or  ${chalk.cyan('Ctrl+C')}            Quit

${chalk.bold('Modes')}
  ${chalk.white('execute')}   Agentic: reads/writes files and runs bash ${chalk.dim('(default)')}
  ${chalk.white('plan')}      Generate a step-by-step plan first, then approve
  ${chalk.white('react')}     ReAct loop: plan → inspect → write → verify

${chalk.bold('Agent tools')}
  ${chalk.blue('read_file')}   Read any file before editing it
  ${chalk.blue('write_file')}  Write complete file contents to disk
  ${chalk.blue('list_dir')}    Explore directory structure
  ${chalk.blue('bash')}        Run shell commands (build, test, git, …)

${chalk.dim('Just type your prompt and press Enter to chat.')}
`);
}

// ── Input prompt ──────────────────────────────────────────────────────────────
// Key fix: use rl.setPrompt() + rl.prompt() so readline owns the prompt string
// and correctly tracks cursor position.  Backspace will never eat the prefix.
function buildPromptStr(mode: TaskMode): string {
  // Plain-text prompt (no ANSI) so readline measures width correctly.
  // We add colour via a workaround: write the coloured prefix, then set an
  // empty prompt so readline only manages the cursor after it.
  // Actually the cleanest approach: use a Unicode-safe coloured prompt via
  // rl.setPrompt with the ANSI string — readline on Node ≥18 handles this
  // correctly because it uses get-east-asian-width internally.
  const arrow = mode === 'execute' ? '\x1b[36m❯\x1b[0m' : mode === 'plan' ? '\x1b[33m❯\x1b[0m' : '\x1b[35m❯\x1b[0m';
  return `\n${arrow} `;
}

function waitForLine(rl: readline.Interface, mode: TaskMode): Promise<string> {
  return new Promise((resolve) => {
    rl.setPrompt(buildPromptStr(mode));
    rl.prompt();
    rl.once('line', (line) => resolve(line.trim()));
  });
}

// ── Main TUI ─────────────────────────────────────────────────────────────────
export async function runTui(master: MasterCoordinator, modelName: string): Promise<void> {
  const rl = readline.createInterface({
    input,
    output,
    terminal: true,
    historySize: 200,
    prompt: '',
  });

  let exiting = false;
  rl.on('SIGINT', () => {
    if (exiting) { rl.close(); process.exit(0); }
    exiting = true;
    process.stdout.write(`\n${ICONS.info} ${chalk.dim('Press Ctrl+C again to exit.')}\n`);
    setTimeout(() => { exiting = false; }, 2000);
  });

  let mode: TaskMode = 'execute';
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  printHeader();
  console.log(chalk.dim(`  Type your prompt and press Enter. Use ${chalk.white('/help')} for commands.\n`));
  printStatusBar(modelName, mode);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let userInput: string;
    try {
      userInput = await waitForLine(rl, mode);
    } catch {
      break;
    }

    if (!userInput) continue;

    // ── Slash commands ───────────────────────────────────────────────────────
    if (userInput.startsWith('/')) {
      const parts  = userInput.slice(1).split(' ');
      const cmd    = parts[0] ?? '';
      const args   = parts.slice(1);

      if (cmd === 'exit' || cmd === 'quit') break;

      if (cmd === 'help') { printHelp(); continue; }

      if (cmd === 'mode') {
        const newMode = args[0] as TaskMode | undefined;
        if (!newMode || !['execute', 'plan', 'react'].includes(newMode)) {
          console.log(`${ICONS.warn} Valid modes: ${chalk.white('execute')}, ${chalk.white('plan')}, ${chalk.white('react')}`);
        } else {
          mode = newMode;
          console.log(`${ICONS.ok} Mode → ${chalk.white(mode)}`);
          printStatusBar(modelName, mode);
        }
        continue;
      }

      if (cmd === 'clear') {
        history.length = 0;
        console.clear();
        printHeader();
        printStatusBar(modelName, mode);
        console.log(`${ICONS.ok} Conversation cleared.`);
        continue;
      }

      if (cmd === 'history') {
        if (history.length === 0) {
          console.log(chalk.dim('  (no history yet)'));
        } else {
          console.log(hr());
          for (const msg of history) {
            const icon    = msg.role === 'user' ? ICONS.user : ICONS.agent;
            const label   = msg.role === 'user' ? chalk.cyan('You') : chalk.magenta('Agent');
            const preview = msg.content.slice(0, 120).replace(/\n/g, ' ');
            const ellipsis = msg.content.length > 120 ? chalk.dim('…') : '';
            console.log(`${icon} ${label}: ${chalk.dim(preview)}${ellipsis}`);
          }
          console.log(hr());
        }
        continue;
      }

      if (cmd === 'tasks') {
        const tasks = master.listTasks();
        if (tasks.length === 0) {
          console.log(chalk.dim('  (no tasks)'));
        } else {
          console.log(hr());
          for (const t of tasks) {
            const sc = t.status === 'completed' ? chalk.green
                     : t.status === 'failed'    ? chalk.red
                     : t.status === 'running'   ? chalk.yellow
                     : chalk.dim;
            console.log(`  ${chalk.dim(t.taskId.slice(0, 8))}  ${chalk.white(t.mode.padEnd(8))}  ${sc(t.status.padEnd(10))}  ${chalk.dim(t.prompt.slice(0, 50))}`);
          }
          console.log(hr());
        }
        continue;
      }

      if (cmd === 'view') {
        const id = args[0];
        if (!id) { console.log(`${ICONS.warn} Usage: /view <taskId>`); continue; }
        const t = master.getTask(id);
        if (!t) { console.log(`${ICONS.fail} Task not found: ${id}`); continue; }
        console.log(hr());
        console.log(chalk.bold('Task:   ') + chalk.white(t.taskId));
        console.log(chalk.bold('Mode:   ') + t.mode + '   ' + chalk.bold('Status: ') + t.status);
        console.log(chalk.bold('Prompt: ') + chalk.dim(t.prompt.slice(0, 200)));
        if (t.plan.length > 0) {
          console.log(chalk.bold('\nPlan:'));
          t.plan.forEach((s, i) => console.log(`  ${chalk.cyan(String(i + 1) + '.')} ${s.title} — ${chalk.dim(s.detail)}`));
        }
        if (t.result) {
          console.log(chalk.bold('\nResult:'));
          console.log(renderMarkdown(t.result, process.stdout.columns || 80));
        }
        console.log(hr());
        continue;
      }

      if (cmd === 'approve') {
        const id = args[0];
        if (!id) { console.log(`${ICONS.warn} Usage: /approve <taskId>`); continue; }
        const spinner = ora({ text: 'Executing plan…', color: 'cyan' }).start();
        const ok = await master.executePlan(id);
        spinner.stop();
        console.log(ok
          ? `${ICONS.ok} Plan execution started for ${chalk.white(id)}`
          : `${ICONS.fail} Could not execute — task not found or not in plan mode`);
        continue;
      }

      if (cmd === 'model') {
        console.log(`${ICONS.info} Model: ${chalk.white(modelName)}`);
        continue;
      }

      console.log(`${ICONS.warn} Unknown command: ${chalk.white('/' + cmd)}. Type ${chalk.cyan('/help')}.`);
      continue;
    }

    // ── Regular prompt → agentic stream ─────────────────────────────────────
    history.push({ role: 'user', content: userInput });

    process.stdout.write(`\n${ICONS.agent} ${chalk.magenta.bold('Agent')}\n`);
    process.stdout.write(hr('─', 40) + '\n');

    const spinner = ora({ text: chalk.dim('Connecting…'), color: 'magenta', spinner: 'dots' }).start();
    let spinnerStopped = false;
    let fullResponse   = '';
    let lineBuffer     = '';

    function stopSpinner(): void {
      if (!spinnerStopped) { spinner.stop(); spinnerStopped = true; }
    }

    // Flush complete lines through the markdown renderer.
    // Partial last line is held in lineBuffer until the next newline or force.
    function flushBuffer(force = false): void {
      if (!lineBuffer) return;
      if (force) {
        process.stdout.write(renderMarkdown(lineBuffer, process.stdout.columns || 80));
        lineBuffer = '';
      } else {
        const nl = lineBuffer.lastIndexOf('\n');
        if (nl !== -1) {
          const toFlush = lineBuffer.slice(0, nl + 1);
          lineBuffer    = lineBuffer.slice(nl + 1);
          process.stdout.write(renderMarkdown(toFlush, process.stdout.columns || 80));
        }
      }
    }

    try {
      const stream = master.streamPrompt('tui-user', userInput, mode, history.slice(0, -1));

      for await (const chunk of stream) {
        switch (chunk.type) {
          case 'phase':
            stopSpinner();
            flushBuffer(true);
            showPhase(chunk.phase, chunk.status, chunk.note);
            break;

          case 'token':
            stopSpinner();
            fullResponse += chunk.text;
            lineBuffer   += chunk.text;
            flushBuffer();
            break;

          case 'tool_call':
            stopSpinner();
            flushBuffer(true);
            showToolCall(chunk.tool, chunk.input);
            break;

          case 'tool_result':
            showToolResult(chunk.tool, chunk.output);
            break;

          case 'error':
            stopSpinner();
            flushBuffer(true);
            process.stdout.write(`\n${ICONS.fail} ${chalk.red(chunk.message)}\n`);
            break;

          case 'done':
            stopSpinner();
            flushBuffer(true);
            break;
        }
      }
    } catch (err) {
      stopSpinner();
      flushBuffer(true);
      process.stdout.write(`\n${ICONS.fail} ${chalk.red(String(err))}\n`);
    }

    stopSpinner();
    flushBuffer(true);

    if (fullResponse) {
      history.push({ role: 'assistant', content: fullResponse });
    }

    process.stdout.write('\n' + hr('─', 40) + '\n');
  }

  rl.close();
  console.log(`\n${ICONS.info} ${chalk.dim('Goodbye.')}\n`);
}
