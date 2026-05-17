#!/usr/bin/env node
import { Command } from 'commander';
import { MasterCoordinator } from './master.js';
import { runTui } from './tui.js';

const program = new Command();
program.name('coding-agent').description('Top-tier coding agent CLI/TUI (TypeScript)').version('0.2.0');

const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const model = process.env.AGENT_MODEL ?? 'deepseek-v4-pro:cloud';
const master = new MasterCoordinator(ollamaBaseUrl, model);

program
  .command('submit')
  .requiredOption('--user <id>', 'user_id: task owner label for tracking and isolation')
  .requiredOption('--prompt <text>')
  .option('--mode <mode>', 'execute | plan | react', 'execute')
  .action(async (opts: { user: string; prompt: string; mode: 'execute' | 'plan' | 'react' }) => {
    const taskId = await master.acceptPrompt(opts.user, opts.prompt, opts.mode);
    console.log(JSON.stringify({ taskId, status: 'accepted', mode: opts.mode }, null, 2));
  });

program
  .command('get')
  .requiredOption('--task <id>')
  .action((opts: { task: string }) => {
    const task = master.getTask(opts.task);
    console.log(JSON.stringify(task ?? { error: 'not_found' }, null, 2));
  });

program
  .command('execute-plan')
  .requiredOption('--task <id>')
  .action(async (opts: { task: string }) => {
    const ok = await master.executePlan(opts.task);
    console.log(JSON.stringify({ taskId: opts.task, accepted: ok }, null, 2));
  });

program
  .command('tui')
  .description('Interactive terminal UI')
  .action(async () => {
    await runTui(master);
  });

program.parseAsync(process.argv);
