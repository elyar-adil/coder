#!/usr/bin/env node
/**
 * Run a real benchmark with the project's own agent.
 *
 * Usage:
 *   npx tsx tests/benchmarks/run_eval.ts --bench humaneval --limit 10
 *
 * Options:
 *   --bench <name>       benchmark to run (currently: humaneval)        [humaneval]
 *   --limit <n>          number of tasks                                [10]
 *   --timeout <ms>       per-task agent timeout                         [180000]
 *   --model <name>       model name                                     [gemma4:31b-cloud]
 *   --base-url <url>     LLM base url                                   [http://localhost:11434]
 *   --keep               keep agent workdirs for debugging
 *   --out <dir>          report output directory
 */
import { writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackendConfig } from '../../src/backend.js';
import { createAgentRunner, makeWorkdir, type AgentRunner } from './agent_runner.js';
import {
  loadHumanEval,
  starterCode,
  buildAgentPrompt,
  evaluateSolution,
  type HumanEvalItem,
} from './humaneval.js';
import { buildReport, writeReport, type TaskResult, type BenchmarkReport } from './report.js';

interface CliArgs {
  bench: string;
  limit: number;
  timeoutMs: number;
  model: string;
  baseUrl: string;
  keep: boolean;
  out: string;
  verbose: boolean;
  resume: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (name: string, fallback: string): string => {
    const idx = argv.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1]! : fallback;
  };
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  return {
    bench: get('bench', 'humaneval'),
    limit: Number(get('limit', '10')) || 10,
    timeoutMs: Number(get('timeout', '180000')) || 180_000,
    model: get('model', 'gemma4:31b-cloud'),
    baseUrl: get('base-url', 'http://localhost:11434'),
    keep: flag('keep'),
    out: get('out', 'tests/benchmarks/reports'),
    verbose: flag('verbose'),
    resume: flag('resume'),
  };
}

/** Load previously-written results so we can resume after a hang/crash. */
async function loadPriorResults(outDir: string, stem: string): Promise<TaskResult[]> {
  try {
    const raw = await readFile(join(outDir, `${stem}-latest.json`), 'utf8');
    const report = JSON.parse(raw) as BenchmarkReport;
    return report.results ?? [];
  } catch {
    return [];
  }
}

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function trunc(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

async function runHumanEval(args: CliArgs): Promise<void> {
  const backend: BackendConfig = {
    type: 'ollama',
    baseUrl: args.baseUrl,
    model: args.model,
  };

  log(`Loading HumanEval (limit=${args.limit}) ...`);
  const items = await loadHumanEval(undefined, args.limit);
  log(`Loaded ${items.length} tasks. Backend: ${backend.type} @ ${backend.baseUrl}, model: ${backend.model}`);
  log(`Per-task timeout: ${args.timeoutMs}ms\n`);

  // Resume support: skip tasks we already have results for. This is essential
  // because the ollama remote model can hang mid-request and the outer timeout
  // can't interrupt an in-flight LLM call — with incremental writes + resume,
  // re-running picks up where we left off instead of starting over.
  const results: TaskResult[] = args.resume ? await loadPriorResults(args.out, 'humaneval') : [];
  const doneLabels = new Set(results.map((r) => r.taskLabel));
  const pending = items.filter((it) => !doneLabels.has(it.task_id));
  if (results.length > 0) {
    log(`Resuming: ${results.length} already done, ${pending.length} remaining.\n`);
  }

  const writeIncremental = async () => {
    const report = buildReport(
      { model: args.model, backend: backend.type, benchmark: 'HumanEval', sampleSize: items.length, timeoutMs: args.timeoutMs },
      results,
    );
    await writeReport(report, args.out, 'humaneval');
  };

  for (let i = 0; i < pending.length; i += 1) {
    const item: HumanEvalItem = pending[i]!;
    log(`[${results.length + 1}/${items.length}] ${item.task_id} — running agent ...`);

    const workdir = await makeWorkdir(item.task_id.replace('/', '-'));
    await writeFile(join(workdir, 'solution.py'), starterCode(item), 'utf8');
    const prompt = buildAgentPrompt(item, workdir);

    // Fresh master per task so a hung LLM request on one task cannot block the
    // next. The outer timeout resolves our promise, but it cannot interrupt an
    // in-flight chatStream await inside the master — isolating instances stops
    // that hang from poisoning the whole run.
    const taskRunner: AgentRunner = createAgentRunner(backend);
    const agentOut = await taskRunner.run({
      taskLabel: item.task_id,
      prompt,
      workdir,
      timeoutMs: args.timeoutMs,
      onEvent: args.verbose
        ? (ev) => {
            if (ev.type === 'tool_call') {
              log(`    [tool] ${ev.tool}: ${trunc(ev.input ?? '', 200)}`);
            } else if (ev.type === 'tool_result') {
              log(`    [result] ${ev.tool}: ${trunc(ev.output ?? '', 200)}`);
            } else if (ev.type === 'task_output') {
              log(`    [out] ${trunc(ev.text ?? '', 200)}`);
            }
          }
        : undefined,
    });

    log(`  agent: ${agentOut.status} in ${(agentOut.durationMs / 1000).toFixed(1)}s, ${agentOut.toolCalls} tool calls`);

    const evalOut = await evaluateSolution(workdir, item);
    const producedRunnable = evalOut.verdict !== 'fail_no_solution' && evalOut.verdict !== 'fail_load';

    const result: TaskResult = {
      taskLabel: item.task_id,
      benchmark: 'HumanEval',
      language: 'python',
      pass: evalOut.pass,
      verdict: evalOut.verdict,
      producedRunnable,
      toolCalls: agentOut.toolCalls,
      durationMs: agentOut.durationMs,
      agentStatus: agentOut.status,
      error: agentOut.error ?? (evalOut.pass ? undefined : evalOut.error),
      output: evalOut.output,
    };
    results.push(result);
    log(`  verdict: ${evalOut.verdict} ${evalOut.pass ? '✓ PASS' : '✗'}\n`);

    // Incremental write so progress survives a hang/crash on a later task.
    await writeIncremental();

    if (!args.keep) {
      try { await rm(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
    } else {
      log(`  (kept workdir: ${workdir})`);
    }
  }

  const report = buildReport(
    { model: args.model, backend: backend.type, benchmark: 'HumanEval', sampleSize: items.length, timeoutMs: args.timeoutMs },
    results,
  );
  const { jsonPath, mdPath } = await writeReport(report, args.out, 'humaneval');

  log('======== RESULTS ========');
  log(`pass@1: ${report.summary.passed}/${report.summary.total} (${(report.summary.passAt1 * 100).toFixed(1)}%)`);
  log(`produced runnable code: ${report.summary.producedRunnable}/${report.summary.total} (${(report.summary.runnableRate * 100).toFixed(1)}%)`);
  log(`avg tool calls: ${report.summary.avgToolCalls.toFixed(1)}`);
  log(`avg duration: ${(report.summary.avgDurationMs / 1000).toFixed(1)}s (passing: ${(report.summary.avgDurationPassingMs / 1000).toFixed(1)}s)`);
  log(`\nReport: ${mdPath}`);
  log(`JSON:   ${jsonPath}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.bench !== 'humaneval') {
    throw new Error(`Unknown bench: ${args.bench}. Currently only 'humaneval' is supported.`);
  }
  await runHumanEval(args);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
