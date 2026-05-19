#!/usr/bin/env node
import { Command } from 'commander';
import { MasterCoordinator } from './master.js';
import { runTui } from './tui.js';
import { loadConfig, saveSelectedModel } from './config.js';
import { resolveModelConfig } from './model-config.js';
import { defaultPolicy } from './policy.js';
import { setToolPolicy } from './tools.js';

async function main(): Promise<void> {
  const program = new Command();
  program.name('coder').description('Top-tier coding agent CLI/TUI (TypeScript)').version('0.2.0');

  // Build backend config from env vars + .agentrc
  let fileConfig = await loadConfig();
  let resolvedModel = resolveModelConfig(fileConfig);

  setToolPolicy(defaultPolicy(fileConfig.policyLevel ?? 'moderate', process.cwd()));

  const master = new MasterCoordinator(resolvedModel.config);

  program
    .option('--model <name>', 'model name or .agentrc model alias')
    .option('--verbose', 'show raw LLM prompt/reply traces in the TUI');

  program
    .command('submit')
    .requiredOption('--user <id>', 'user_id: task owner label for tracking and isolation')
    .requiredOption('--prompt <text>')
    .option('--mode <mode>', 'execute | plan | react', 'execute')
    .action(async (opts: { user: string; prompt: string; mode: 'execute' | 'plan' | 'react' }) => {
      const globalOpts = program.opts<{ model?: string; verbose?: boolean }>();
      resolvedModel = resolveModelConfig(fileConfig, globalOpts.model);
      master.setBackendConfig(resolvedModel.config);
      master.setLlmTracingEnabled(Boolean(globalOpts.verbose));
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
      const globalOpts = program.opts<{ model?: string; verbose?: boolean }>();
      resolvedModel = resolveModelConfig(fileConfig, globalOpts.model);
      master.setBackendConfig(resolvedModel.config);
      master.setLlmTracingEnabled(Boolean(globalOpts.verbose));
      await runTui(
        master,
        resolvedModel.name,
        (name?: string) => resolveModelConfig(fileConfig, name),
        Array.from(new Set([
          ...(fileConfig.model ? [fileConfig.model] : []),
          ...Object.keys(fileConfig.models ?? {}),
        ])),
        async (name: string) => {
          await saveSelectedModel(name);
          fileConfig = {
            ...fileConfig,
            model: name,
          };
        },
        { verbose: Boolean(globalOpts.verbose) },
      );
    });

  // Default to TUI when no subcommand is given, including global-option-only invocations.
  const subcommands = new Set(program.commands.map((command) => command.name()));
  if (!process.argv.slice(2).some((arg) => subcommands.has(arg))) {
    process.argv.push('tui');
  }

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
