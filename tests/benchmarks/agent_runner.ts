import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MasterCoordinator } from '../../src/runtime/coordinator.js';
import type { BackendConfig } from '../../src/backend.js';
import { defaultPolicy } from '../../src/policy.js';
import { setToolPolicy } from '../../src/infra/tools.js';

/**
 * Agent runner: drives the project's own MasterCoordinator against a single
 * isolated task. This is the bridge that turns the existing harness from a
 * "run a test command" scaffold into a real agent benchmark — the agent now
 * actually solves the task with its tool loop, and we measure the outcome.
 */

export interface AgentRunInput {
  /** Stable label for the task, e.g. "HumanEval/0". */
  taskLabel: string;
  /** Full instruction text handed to the agent. */
  prompt: string;
  /** Isolated working directory; starter files already written here. */
  workdir: string;
  /** Hard timeout in ms. The agent is killed (logically) past this. */
  timeoutMs: number;
  /** Optional event tap for diagnostics (verbose mode). */
  onEvent?: (event: { type: string; tool?: string; input?: string; output?: string; text?: string }) => void;
}

export interface AgentRunOutput {
  taskId: string;
  taskLabel: string;
  /** terminal status from the coordinator's task lifecycle */
  status: 'completed' | 'failed' | 'timeout';
  /** agent's final result text (may contain an explanation or error) */
  result: string;
  /** number of tool_call events observed — a proxy for "steps taken" */
  toolCalls: number;
  /** wall-clock duration in ms */
  durationMs: number;
  error?: string;
}

export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunOutput>;
}

/**
 * Build a runner backed by the given LLM backend. Each runner owns its own
 * MasterCoordinator instance so concurrent runs (if ever needed) don't share
 * routing state. For the first version we run tasks serially.
 */
export function createAgentRunner(backend: BackendConfig): AgentRunner {
  // Moderate policy scoped to the project root. Workdirs live under
  // .agent-workspace/bench/ (see makeWorkdir) so they sit inside the workspace
  // and read_file/edit_file are authorized. The coordinator snapshots the
  // policy at construction, so setToolPolicy must run before `new MasterCoordinator`.
  setToolPolicy(defaultPolicy('moderate', process.cwd()));
  const master = new MasterCoordinator(backend);
  master.setBackendConfig(backend);

  return {
    async run(input: AgentRunInput): Promise<AgentRunOutput> {
      const start = Date.now();
      let toolCalls = 0;
      let settled = false;

      // acceptPrompt returns synchronously after creating the task; routing
      // runs on a setTimeout(0), so subscribing right after cannot miss the
      // task_done event.
      const taskId = await master.acceptPrompt(
        'eval',
        input.prompt,
        'build',
        [],
        { artifactDir: input.workdir },
      );

      let resolveDone!: (o: AgentRunOutput) => void;
      const done = new Promise<AgentRunOutput>((res) => {
        resolveDone = res;
      });

      const finish = (patch: Pick<AgentRunOutput, 'status' | 'result' | 'error'>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolveDone({
          taskId,
          taskLabel: input.taskLabel,
          status: patch.status,
          result: patch.result ?? '',
          toolCalls,
          durationMs: Date.now() - start,
          error: patch.error,
        });
      };

      const unsubscribe = master.subscribe((event) => {
        if (event.taskId !== taskId) return;
        if (event.type === 'tool_call') {
          toolCalls += 1;
          input.onEvent?.({ type: 'tool_call', tool: event.tool, input: event.input });
        } else if (event.type === 'tool_result') {
          input.onEvent?.({ type: 'tool_result', tool: event.tool, output: event.output });
        } else if (event.type === 'task_output') {
          input.onEvent?.({ type: 'task_output', text: event.text });
        }
        if (event.type === 'task_done') {
          finish({ status: event.status, result: event.result });
        }
      });

      const timer = setTimeout(
        () => finish({ status: 'timeout', error: `timeout after ${input.timeoutMs}ms` }),
        input.timeoutMs,
      );

      return done;
    },
  };
}

/**
 * Create a fresh isolated working directory for one task. Workdirs live inside
 * the project under .agent-workspace/bench/ so the moderate tool policy
 * (workspaceRoot = project root) authorizes read/write access to them.
 */
export async function makeWorkdir(prefix: string): Promise<string> {
  const safe = prefix.replace(/[^a-z0-9_-]/gi, '_');
  const base = join(process.cwd(), '.agent-workspace', 'bench');
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, `coder-bench-${safe}-`));
}
