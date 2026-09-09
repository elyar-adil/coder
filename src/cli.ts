#!/usr/bin/env node
import { Command } from 'commander';

import { loadConfig, saveConfig, saveSelectedModel, type AgentConfig } from './config.js';
import { setToolPolicy } from './infra/tools.js';
import { resolveModelConfig } from './model-config.js';
import { defaultPolicy } from './policy.js';
import { AgentRegistry } from './runtime/agent-registry.js';
import { AgentRuntime } from './runtime/agent-runtime.js';
import { WorktreeManager } from './runtime/worktree.js';
import { registerWorkspaceInstance } from './runtime/workspace-instances.js';
import { runFullscreenTui } from './ui/fullscreen-tui.js';
import { checkForUpdate, formatUpdateNotice, offerSelfUpdate } from './update-check.js';
import { CODER_VERSION } from './version.js';

async function main(): Promise<void> {
  const program = new Command();
  program.name('maw').description('Document-driven coding agent runtime').version(CODER_VERSION);
  program.allowExcessArguments(false).showSuggestionAfterError();
  program.option('--model <name>', 'default model name or .agentrc alias');
  program.option('--worktree [name]', 'start inside an isolated managed git worktree (.coder/worktrees/<name>)');

  // Query npm for a newer release while the command runs; afterwards a y/N
  // prompt offers a self-update (China mirror first) in interactive sessions.
  const updateNotice = checkForUpdate().catch(() => null);
  const showUpdateNotice = async (): Promise<void> => {
    const result = await updateNotice;
    if (!result?.updateAvailable || !process.stderr.isTTY) return;
    process.stderr.write(`\n${formatUpdateNotice(result)}\n`);
    const message = await offerSelfUpdate(result).catch(() => null);
    if (message) process.stderr.write(`\n${message}\n`);
  };

  let config = await loadConfig();
  const selectedFromCli = (): string | undefined => program.opts<{ model?: string }>().model;
  setToolPolicy(defaultPolicy(config.policyLevel ?? 'moderate', process.cwd()));

  const registry = new AgentRegistry({ workspaceRoot: process.cwd() });
  const runtime = new AgentRuntime({
    registry,
    workspaceRoot: process.cwd(),
    defaultModel: selectedFromCli() ?? config.model,
    resolveModel: (alias) => resolveModelConfig(config, alias).config,
  });

  // Announce this instance so concurrent maw processes in the same workspace
  // can surface a warning (and users can see who else is editing).
  const stopInstanceHeartbeat = await registerWorkspaceInstance(process.cwd());

  // /cd moves the runtime to a new workspace root; the tool policy must follow
  // so read/write authorization keeps covering the new tree.
  runtime.subscribe((event) => {
    if (event.type !== 'workspace_changed') return;
    setToolPolicy(defaultPolicy(config.policyLevel ?? 'moderate', event.workspaceRoot));
    void registerWorkspaceInstance(event.workspaceRoot).then((stop) => {
      void stopInstanceHeartbeat().then(stop);
    });
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
      runtime.setDefaultModel(selectedFromCli() ?? config.model);
      try {
        await runtime.whenReady();
        const sessionId = options.session ?? `run-${Date.now()}`;
        await runtime.openSession(sessionId);
        if (selectedFromCli()) await runtime.setSessionDefaultModel(sessionId, selectedFromCli());
        const turnId = await runtime.submitMessage(sessionId, options.prompt);
        await runtime.waitForIdle(sessionId);
        const session = runtime.getSession(sessionId)!;
        const failed = runtime.listInstances(sessionId).find((instance) => instance.status === 'failed');
        if (failed) throw new Error(failed.lastError ?? 'Agent failed');
        const submitted = session.messages.findIndex((message) => message.role === 'user' && message.turnId === turnId);
        const response = session.messages.slice(submitted + 1).reverse().find((message) => message.role === 'assistant');
        if (response) process.stdout.write(`${response.content}\n`);
        await showUpdateNotice();
      } finally {
        await runtime.shutdown();
      }
    });

  program
    .command('agents')
    .description('List effective Agent Specs')
    .action(async () => {
      await runtime.whenReady();
      for (const spec of runtime.listAgentSpecs()) {
        process.stdout.write(`${spec.id}\t${spec.scope}\t${spec.model ?? 'inherit'}\t${spec.description}\n`);
      }
      await showUpdateNotice();
      await runtime.shutdown();
    });

  program.action(async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive mode requires a terminal. Use maw run --prompt "..." for non-interactive execution.');
    await runtime.whenReady();
    const worktreeArg = program.opts<{ worktree?: boolean | string }>().worktree;
    if (worktreeArg !== undefined) {
      const manager = new WorktreeManager(process.cwd());
      if (!await manager.isGitRepository()) {
        console.error('--worktree requires a git repository');
        process.exitCode = 1;
        return;
      }
      const name = typeof worktreeArg === 'string' && worktreeArg.trim() ? worktreeArg.trim() : `session-${Date.now()}`;
      const info = await manager.create(name);
      await runtime.changeWorkspace(info.path);
      process.stdout.write(`worktree ready: ${info.path} (${info.branch})\n`);
    }
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
    await showUpdateNotice();
    await runtime.shutdown();
  });

  const shutdown = async (): Promise<void> => {
    await runtime.shutdown().catch(() => undefined);
    await stopInstanceHeartbeat().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', () => { void shutdown(); });
  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
