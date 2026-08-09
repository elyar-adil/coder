import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Reporting: turns a batch of per-task results into a summary + a JSON and
 * Markdown artifact. The Markdown report is what a human reads to see "where
 * we stand"; the JSON is what future runs diff against. A `comparisons` slot
 * is reserved so Claude Code / Codex numbers can be filled in later for the
 * head-to-head view the user wants.
 */

export interface TaskResult {
  taskLabel: string;       // "HumanEval/0"
  benchmark: string;       // "HumanEval"
  language: string;        // "python"
  pass: boolean;
  verdict: string;         // pass | fail_assert | fail_load | fail_no_solution | fail_eval_error
  /** agent produced code that imports cleanly (syntax + entry point present) */
  producedRunnable: boolean;
  toolCalls: number;
  durationMs: number;
  agentStatus: string;     // completed | failed | timeout
  error?: string;
  output?: string;         // evaluator output (truncated)
}

export interface ReportConfig {
  model: string;
  backend: string;
  benchmark: string;
  sampleSize: number;
  timeoutMs: number;
}

export interface BenchmarkReport {
  generatedAt: string;
  config: ReportConfig;
  summary: {
    total: number;
    passed: number;
    passAt1: number;            // fraction 0..1
    producedRunnable: number;
    runnableRate: number;       // fraction 0..1
    avgToolCalls: number;
    avgDurationMs: number;
    avgDurationPassingMs: number;
  };
  /** Head-to-head placeholder; fill Claude Code / Codex pass@1 when measured. */
  comparisons: Array<{ agent: string; passAt1?: number; note?: string }>;
  results: TaskResult[];
}

export function buildReport(config: ReportConfig, results: TaskResult[]): BenchmarkReport {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const runnable = results.filter((r) => r.producedRunnable).length;
  const passing = results.filter((r) => r.pass);
  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  return {
    generatedAt: new Date().toISOString(),
    config,
    summary: {
      total,
      passed,
      passAt1: total ? passed / total : 0,
      producedRunnable: runnable,
      runnableRate: total ? runnable / total : 0,
      avgToolCalls: avg(results.map((r) => r.toolCalls)),
      avgDurationMs: avg(results.map((r) => r.durationMs)),
      avgDurationPassingMs: avg(passing.map((r) => r.durationMs)),
    },
    comparisons: [
      { agent: `ours (${config.model})`, passAt1: total ? passed / total : 0 },
      { agent: 'Claude Code', note: 'not measured yet' },
      { agent: 'Codex', note: 'not measured yet' },
    ],
    results,
  };
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function trunc(s: string | undefined, max = 200): string {
  if (!s) return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export function toMarkdown(report: BenchmarkReport): string {
  const { config, summary, comparisons, results } = report;
  const lines: string[] = [];
  lines.push(`# Benchmark Report: ${config.benchmark} (${config.model})`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Backend: \`${config.backend}\` · Sample size: ${config.sampleSize} · Timeout: ${fmtMs(config.timeoutMs)}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| pass@1 | **${summary.passed}/${summary.total} (${pct(summary.passAt1)})** |`);
  lines.push(`| Produced runnable code | ${summary.producedRunnable}/${summary.total} (${pct(summary.runnableRate)}) |`);
  lines.push(`| Avg tool calls | ${summary.avgToolCalls.toFixed(1)} |`);
  lines.push(`| Avg duration (all) | ${fmtMs(summary.avgDurationMs)} |`);
  lines.push(`| Avg duration (passing) | ${fmtMs(summary.avgDurationPassingMs)} |`);
  lines.push('');
  lines.push('## Per-task');
  lines.push('| Task | Pass | Verdict | Steps | Duration | Agent | Note |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of results) {
    const mark = r.pass ? '✓' : '✗';
    const note = r.pass ? '' : trunc(r.error ?? r.output, 120);
    lines.push(`| ${r.taskLabel} | ${mark} | ${r.verdict} | ${r.toolCalls} | ${fmtMs(r.durationMs)} | ${r.agentStatus} | ${note} |`);
  }
  lines.push('');
  lines.push('## Head-to-head (placeholder)');
  lines.push('| Agent | pass@1 |');
  lines.push('|---|---|');
  for (const c of comparisons) {
    lines.push(`| ${c.agent} | ${c.passAt1 !== undefined ? pct(c.passAt1) : (c.note ?? '—')} |`);
  }
  lines.push('');
  lines.push('_Claude Code / Codex rows are placeholders — fill in once their runs are measured on the same task slice._');
  return lines.join('\n');
}

export async function writeReport(
  report: BenchmarkReport,
  outDir = 'tests/benchmarks/reports',
  stem = 'humaneval',
): Promise<{ jsonPath: string; mdPath: string }> {
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(outDir, `${stem}-${stamp}.json`);
  const mdPath = join(outDir, `${stem}-${stamp}.md`);
  const latestJson = join(outDir, `${stem}-latest.json`);
  const latestMd = join(outDir, `${stem}-latest.md`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(mdPath, toMarkdown(report), 'utf8');
  await writeFile(latestJson, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(latestMd, toMarkdown(report), 'utf8');
  return { jsonPath, mdPath };
}
