#!/usr/bin/env node
import { Command } from 'commander';
import { MasterCoordinator } from './master.js';
import { runTui } from './tui.js';
import { detectBackend, type BackendConfig, type BackendType } from './backend.js';
import { loadConfig } from './config.js';
import { defaultPolicy } from './policy.js';
import { setToolPolicy } from './tools.js';

async function main(): Promise<void> {
  const program = new Command();
  program.name('coder').description('Top-tier coding agent CLI/TUI (TypeScript)').version('0.2.0');

  // Build backend config from env vars + .agentrc
  const fileConfig = await loadConfig();
  const baseUrl  = process.env.LLM_BASE_URL ?? process.env.OLLAMA_BASE_URL ?? fileConfig.baseUrl ?? 'http://localhost:11434';
  const model    = process.env.AGENT_MODEL    ?? fileConfig.model    ?? 'gemma4:31b-cloud';
  const backend  = (process.env.LLM_BACKEND   ?? fileConfig.backend  ?? detectBackend(baseUrl)) as BackendType;
  const apiKey   = process.env.LLM_API_KEY    ?? fileConfig.apiKey;

  const backendConfig: BackendConfig = {
    type: backend,
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
  };

  setToolPolicy(defaultPolicy(fileConfig.policyLevel ?? 'moderate', process.cwd()));

  const master = new MasterCoordinator(backendConfig);

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
    .description('Interactive terminal UI — Claude Code-class experience')
    .action(async () => {
      await runTui(master, model);
    });

  // Default to TUI when no subcommand given
  if (process.argv.length === 2) {
    process.argv.push('tui');
  }

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
