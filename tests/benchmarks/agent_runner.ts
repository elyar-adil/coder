import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { BackendConfig } from '../../src/backend.js';
import { setToolPolicy } from '../../src/infra/tools.js';
import { defaultPolicy } from '../../src/policy.js';
import { AgentRegistry } from '../../src/runtime/agent-registry.js';
import { AgentRuntime } from '../../src/runtime/agent-runtime.js';

export interface AgentRunInput {
  taskLabel: string;
  prompt: string;
  workdir: string;
  timeoutMs: number;
  onEvent?: (event: { type: string; tool?: string; input?: string; output?: string; text?: string }) => void;
}

export interface AgentRunOutput {
  taskId: string;
  taskLabel: string;
  status: 'completed' | 'failed' | 'timeout';
  result: string;
  toolCalls: number;
  durationMs: number;
  error?: string;
}

export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunOutput>;
}

export function createAgentRunner(backend: BackendConfig): AgentRunner {
  return {
    async run(input: AgentRunInput): Promise<AgentRunOutput> {
      const started = Date.now();
      let toolCalls = 0;
      const sessionId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToolPolicy(defaultPolicy('moderate', input.workdir));
      const registry = new AgentRegistry({
        workspaceRoot: input.workdir,
        builtinDir: resolve(process.cwd(), 'agents'),
      });
      const runtime = new AgentRuntime({
        registry,
        workspaceRoot: input.workdir,
        defaultModel: backend.model,
        resolveModel: () => backend,
      });
      const unsubscribe = runtime.subscribe((event) => {
        if (event.type === 'tool_started') {
          toolCalls += 1;
          input.onEvent?.({ type: event.type, tool: event.tool, input: event.input });
        } else if (event.type === 'tool_finished') {
          input.onEvent?.({ type: event.type, tool: event.tool, output: event.output });
        } else if (event.type === 'assistant_delta') {
          input.onEvent?.({ type: event.type, text: event.text });
        }
      });
      try {
        await runtime.openSession(sessionId);
        const turnId = await runtime.submitMessage(sessionId, input.prompt);
        await Promise.race([
          runtime.waitForIdle(sessionId, input.timeoutMs),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`timeout after ${input.timeoutMs}ms`)), input.timeoutMs)),
        ]);
        const session = runtime.getSession(sessionId)!;
        const result = [...session.messages].reverse().find((message) => message.role === 'assistant')?.content ?? '';
        const failed = runtime.listInstances(sessionId).find((instance) => instance.status === 'failed');
        return {
          taskId: turnId,
          taskLabel: input.taskLabel,
          status: failed ? 'failed' : 'completed',
          result,
          toolCalls,
          durationMs: Date.now() - started,
          ...(failed?.lastError ? { error: failed.lastError } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          taskId: sessionId,
          taskLabel: input.taskLabel,
          status: message.includes('timeout') ? 'timeout' : 'failed',
          result: '',
          toolCalls,
          durationMs: Date.now() - started,
          error: message,
        };
      } finally {
        unsubscribe();
        await runtime.shutdown();
      }
    },
  };
}

export async function makeWorkdir(prefix: string): Promise<string> {
  const safe = prefix.replace(/[^a-z0-9_-]/gi, '_');
  const base = join(process.cwd(), '.agent-workspace', 'bench');
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, `coder-bench-${safe}-`));
}
