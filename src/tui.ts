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
import ora, { type Ora } from 'ora';
import { renderMarkdown } from './markdown.js';
import { FetchError } from './fetch.js';
import { ConversationStore, type ConversationEntry } from './store.js';
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
  read_file:        'Reading',
  write_file:       'Writing',
  list_dir:         'Listing',
  bash:             'Running',
  load_skill:       'Loading skill',
  spawn_subagent:   'Spawning agent',
  collect_subagent: 'Collecting agent',
  ask_user:         'Asking you',
};

const PHASE_LABELS: Record<TaskPhase, string> = {
  plan:         'Planning',
  design:       'Designing',
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
  ${chalk.white('execute')}   Agentic: reads/writes files and runs bash ${chalk.dim('(default)')}
  ${chalk.white('plan')}      Generate a step-by-step plan first, then approve
  ${chalk.white('react')}     ReAct loop: plan → inspect → write → verify

${chalk.bold('Agent tools')}
  ${chalk.blue('read_file')}   Read any file before editing it
  ${chalk.blue('write_file')}  Write complete file contents to disk
  ${chalk.blue('list_dir')}    Explore directory structure
  ${chalk.blue('bash')}        Run shell commands (build, test, git, …)

${chalk.dim('Shortcut: Shift+Tab toggles execute/plan mode.')}
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

  rl.on('close', () => {
    if (input.isTTY) input.setRawMode(false);
    input.off('keypress', onKeypress);
  });

  let mode: TaskMode = 'execute';

  // Keyboard shortcuts:
  //   Shift+Tab => toggle execute <-> plan
  // Plan mode is planning-only and does not modify files.
  readline.emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);
  const onKeypress = (_str: string, key: { name?: string; meta?: boolean; shift?: boolean; ctrl?: boolean; sequence?: string }): void => {
    if (key?.ctrl && key.name === 'c') return;
    const isShiftTab = (key?.name === 'tab' && key?.shift) || key?.sequence === '\x1b[Z';
    if (isShiftTab) {
      mode = mode === 'plan' ? 'execute' : 'plan';
      console.log(`
${ICONS.ok} Mode → ${chalk.white(mode)} ${chalk.dim(mode === 'plan' ? '(planning only; no file modifications)' : '')}`);
      printStatusBar(modelName, mode);
      rl.prompt(true);
    }
  };
  input.on('keypress', onKeypress);

  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  // ── Conversation persistence ────────────────────────────────────────────────
  const convStore = new ConversationStore();
  await convStore.init();
  const sessionId = `session-${Date.now()}`;

  // Auto-save on each exchange
  async function saveHistory(): Promise<void> {
    await convStore.save(sessionId, history);
  }

  printHeader();
  console.log(chalk.dim(`  Type your prompt and press Enter. Use ${chalk.white('/help')} for commands.\n`));
  printStatusBar(modelName, mode);
  process.stdout.write(`${ICONS.ok} ${chalk.green('Ready')} — ${chalk.dim('model:')} ${chalk.white(modelName)}  ${chalk.dim('mode:')} ${chalk.white(mode)}\n\n`);

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
        await convStore.remove(sessionId);
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
            const phase = t.phaseEvents.length > 0 ? chalk.dim('[' + t.phaseEvents[t.phaseEvents.length - 1]!.phase + ']') : '';
            console.log(`  ${chalk.dim(t.taskId.slice(0, 8))}  ${chalk.white(t.mode.padEnd(8))}  ${sc(t.status.padEnd(10))}  ${phase}  ${chalk.dim(t.prompt.slice(0, 40))}`);
          }
          console.log(hr());
        }
        continue;
      }

      if (cmd === 'subagents') {
        const subs = master.listSubagents();
        if (subs.length === 0) {
          console.log(chalk.dim('  (no sub-agents)'));
        } else {
          console.log(hr());
          for (const s of subs) {
            const sc = s.status === 'completed' ? chalk.green : s.status === 'failed' ? chalk.red : chalk.yellow;
            console.log(`  ${chalk.dim(s.taskId.slice(0, 8))}  ${sc(s.status.padEnd(10))}  ${chalk.dim(s.prompt.slice(0, 60))}`);
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

      if (cmd === 'resume') {
        const id = args[0];
        if (!id) { console.log(`${ICONS.warn} Usage: /resume <taskId>`); continue; }
        const t = master.getTask(id);
        if (!t) { console.log(`${ICONS.fail} Task not found: ${id}`); continue; }
        if (t.status === 'completed' || t.status === 'failed') {
          console.log(`${ICONS.info} Task already ${t.status}. Use /view ${id} to see result.`);
          continue;
        }
        const ok = await master.resolveTask(id);
        console.log(ok ? `${ICONS.ok} Resuming task ${chalk.white(id)}` : `${ICONS.fail} Cannot resume task`);
        continue;
      }

      if (cmd === 'sessions') {
        const sessions = await convStore.list();
        if (sessions.length === 0) {
          console.log(chalk.dim('  (no saved sessions)'));
        } else {
          console.log(hr());
          for (const s of sessions.slice(0, 10)) {
            const ts = new Date(s.modified).toLocaleString();
            console.log(`  ${chalk.dim(s.id)}  ${chalk.white(s.entries + ' msgs')}  ${chalk.dim(ts)}`);
          }
          console.log(hr());
        }
        continue;
      }

      if (cmd === 'load') {
        const id = args[0];
        if (!id) { console.log(`${ICONS.warn} Usage: /load <sessionId>`); continue; }
        const loaded = await convStore.load(id);
        if (loaded.length === 0) {
          console.log(`${ICONS.fail} Session not found or empty: ${id}`);
        } else {
          history.length = 0;
          history.push(...loaded);
          console.log(`${ICONS.ok} Loaded ${chalk.white(loaded.length)} messages from ${chalk.dim(id)}`);
        }
        continue;
      }

      console.log(`${ICONS.warn} Unknown command: ${chalk.white('/' + cmd)}. Type ${chalk.cyan('/help')}.`);
      continue;
    }

    // ── Regular prompt → agentic stream ─────────────────────────────────────
    history.push({ role: 'user', content: userInput });

    process.stdout.write(`\n${ICONS.agent} ${chalk.magenta.bold('Agent')}\n`);
    process.stdout.write(hr('─', 40) + '\n');

    let spinner: Ora | null = null;
    let fullResponse   = '';
    let lineBuffer     = '';
    let progressTicker: NodeJS.Timeout | null = null;

    function startProgressTicker(text: string): void {
      if (progressTicker) clearInterval(progressTicker);
      const started = Date.now();
      progressTicker = setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        process.stdout.write(`${ICONS.info} ${chalk.dim(`${text} (${elapsed}s)`) }\n`);
      }, 4000);
    }

    function stopProgressTicker(): void {
      if (progressTicker) {
        clearInterval(progressTicker);
        progressTicker = null;
      }
    }

    function startSpinner(text: string): void {
      if (spinner) spinner.stop();
      spinner = ora({ text: chalk.dim(text), color: 'magenta', spinner: 'dots' }).start();
      startProgressTicker(text);
    }

    function stopSpinner(): void {
      if (spinner) { spinner.stop(); spinner = null; }
      stopProgressTicker();
    }

    startSpinner('Thinking…');

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

    let currentTaskId = '';

    try {
      const stream = master.streamPrompt('tui-user', userInput, mode, history.slice(0, -1));

      for await (const chunk of stream) {
        switch (chunk.type) {
          case 'task_id':
            currentTaskId = chunk.taskId;
            break;

          case 'phase':
            flushBuffer(true);
            showPhase(chunk.phase, chunk.status, chunk.note);
            if (chunk.status === 'in_progress') {
              const label = PHASE_LABELS[chunk.phase] ?? chunk.phase;
              startSpinner(label + '…');
            } else {
              stopSpinner();
            }
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
            if (chunk.tool === 'bash') startSpinner('Running…');
            break;

          case 'tool_result':
            stopSpinner();
            showToolResult(chunk.tool, chunk.output);
            break;

          case 'ask_user': {
            stopSpinner();
            flushBuffer(true);
            process.stdout.write(`\n${ICONS.warn} ${chalk.yellow('Agent asks:')} ${chunk.question}\n`);
            process.stdout.write(chalk.cyan('  Your answer') + ' > ');
            const answer = await new Promise<string>((resolve) => {
              rl.once('line', (line) => resolve(line.trim()));
              rl.prompt();
            });
            master.answerUser(currentTaskId, answer);
            process.stdout.write(`${ICONS.ok} ${chalk.dim('Answer sent to agent')}\n`);
            break;
          }

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
      if (err instanceof FetchError) {
        process.stdout.write(`\n${ICONS.fail} ${chalk.red('Connection error:')} ${chalk.yellow(err.message)}\n`);
        if (!err.retriable) {
          process.stdout.write(`${ICONS.info} ${chalk.dim('Check that Ollama is running and OLLAMA_BASE_URL is correct.')}\n`);
        }
      } else {
        process.stdout.write(`\n${ICONS.fail} ${chalk.red(String(err))}\n`);
      }
    }

    stopSpinner();
    flushBuffer(true);

    if (fullResponse) {
      history.push({ role: 'assistant', content: fullResponse });
    }

    await saveHistory();
    process.stdout.write('\n' + hr('─', 40) + '\n');
  }

  rl.close();
  await saveHistory();
  console.log(`\n${ICONS.info} ${chalk.dim('Goodbye. Session saved.')}\n`);
}
