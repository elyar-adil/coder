#!/usr/bin/env node
import { Command } from 'commander';

import { loadConfig, saveConfig, saveSelectedModel, type AgentConfig } from './config.js';
import { setToolPolicy } from './infra/tools.js';
import { resolveModelConfig } from './model-config.js';
import { defaultPolicy } from './policy.js';
import { AgentRegistry } from './runtime/agent-registry.js';
import { AgentRuntime } from './runtime/agent-runtime.js';
import { runFullscreenTui } from './ui/fullscreen-tui.js';

async function main(): Promise<void> {
  const program = new Command();
  program.name('coder').description('Document-driven coding agent runtime').version('0.3.0');
  program.allowExcessArguments(false).showSuggestionAfterError();
  program.option('--model <name>', 'default model name or .agentrc alias');

  let config = await loadConfig();
  const selectedFromCli = (): string | undefined => program.opts<{ model?: string }>().model;
  const resolvedDefault = resolveModelConfig(config, selectedFromCli());
  setToolPolicy(defaultPolicy(config.policyLevel ?? 'moderate', process.cwd()));

  const registry = new AgentRegistry({ workspaceRoot: process.cwd() });
  const runtime = new AgentRuntime({
    registry,
    workspaceRoot: process.cwd(),
    defaultModel: selectedFromCli() ?? config.model,
    resolveModel: (alias) => resolveModelConfig(config, alias).config,
  });

  const configManager = {
    getConfig: (): AgentConfig => config,
    saveConfig: async (next: AgentConfig): Promise<void> => {
      await saveConfig(next);
      config = next;
      setToolPolicy(defaultPolicy(config.policyLevel ?? 'moderate', process.cwd()));
    },
  };

  program
    .command('run')
    .description('Run one non-interactive main-agent session')
    .requiredOption('--prompt <text>', 'message for the main agent')
    .option('--session <id>', 'session id')
    .action(async (options: { prompt: string; session?: string }) => {
      await runtime.whenReady();
      const sessionId = options.session ?? `run-${Date.now()}`;
      await runtime.openSession(sessionId);
      await runtime.submitMessage(sessionId, options.prompt);
      await runtime.waitForIdle(sessionId);
      const session = runtime.getSession(sessionId)!;
      const response = [...session.messages].reverse().find((message) => message.role === 'assistant');
      if (response) process.stdout.write(`${response.content}\n`);
      await runtime.shutdown();
    });

  program
    .command('agents')
    .description('List effective Agent Specs')
    .action(async () => {
      await runtime.whenReady();
      for (const spec of runtime.listAgentSpecs()) {
        process.stdout.write(`${spec.id}\t${spec.scope}\t${spec.model ?? 'inherit'}\t${spec.description}\n`);
      }
      await runtime.shutdown();
    });

  program.action(async () => {
    await runtime.whenReady();
    const requested = selectedFromCli();
    const selected = resolveModelConfig(config, requested);
    runtime.setDefaultModel(requested ?? config.model);
    await runFullscreenTui(runtime, {
      modelName: selected.name,
      modelAliases: Object.keys(config.models ?? {}),
      resolveModel: (alias) => resolveModelConfig(config, alias),
      persistModelSelection: async (alias) => {
        await saveSelectedModel(alias);
        config = { ...config, model: alias };
      },
      configManager,
    });
    await runtime.shutdown();
  });

  const shutdown = async (): Promise<void> => {
    await runtime.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => { void shutdown(); });
  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
