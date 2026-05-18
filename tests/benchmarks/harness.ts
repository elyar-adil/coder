import { mkdtemp, readFile, rm, writeFile, mkdir, cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { exec as _exec } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(_exec);

export interface EvalTask {
  id: string;
  name: string;
  repoPath: string;
  workspaceSubdir?: string;
  setupCommands?: string[];
  patch?: Array<{ path: string; find: string; replace: string }>;
  testCommand: string;
  successPattern?: string;
}

export interface EvalResult {
  id: string;
  name: string;
  success: boolean;
  output: string;
  error?: string;
  workdir: string;
}

export async function loadTasks(path = 'tests/benchmarks/tasks.sample.json'): Promise<EvalTask[]> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as { tasks: EvalTask[] };
  return parsed.tasks;
}

async function applyPatchOps(workdir: string, ops: NonNullable<EvalTask['patch']>): Promise<void> {
  for (const op of ops) {
    const filePath = resolve(workdir, op.path);
    const raw = await readFile(filePath, 'utf8');
    if (!raw.includes(op.find)) throw new Error(`patch find string missing: ${op.path}`);
    const next = raw.replace(op.find, op.replace);
    await writeFile(filePath, next, 'utf8');
  }
}

export async function runTask(task: EvalTask): Promise<EvalResult> {
  const temp = await mkdtemp(join(tmpdir(), `coder-eval-${task.id}-`));
  const src = resolve(task.repoPath);
  const checkout = join(temp, 'repo');
  await cp(src, checkout, { recursive: true });
  const workdir = task.workspaceSubdir ? resolve(checkout, task.workspaceSubdir) : checkout;
  try {
    for (const cmd of task.setupCommands ?? []) {
      await exec(cmd, { cwd: workdir, timeout: 180_000, maxBuffer: 1024 * 1024 * 8 });
    }
    if (task.patch?.length) await applyPatchOps(workdir, task.patch);

    const { stdout, stderr } = await exec(task.testCommand, {
      cwd: workdir,
      timeout: 180_000,
      maxBuffer: 1024 * 1024 * 8,
    });
    const output = [stdout, stderr].filter(Boolean).join('\n');
    const success = task.successPattern ? new RegExp(task.successPattern, 'i').test(output) : true;
    await rm(temp, { recursive: true, force: true });
    return { id: task.id, name: task.name, success, output, workdir };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = [err.stdout, err.stderr].filter(Boolean).join('\n');
    await rm(temp, { recursive: true, force: true });
    return { id: task.id, name: task.name, success: false, output, error: err.message ?? String(e), workdir };
  }
}

export async function runEvalSuite(tasks: EvalTask[]): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const task of tasks) results.push(await runTask(task));
  return results;
}

export function summarize(results: EvalResult[]): { total: number; passed: number; passRate: number } {
  const total = results.length;
  const passed = results.filter((r) => r.success).length;
  return { total, passed, passRate: total === 0 ? 0 : passed / total };
}

export async function writeReport(results: EvalResult[], outPath = 'tests/benchmarks/reports/latest.json'): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  const summary = summarize(results);
  await writeFile(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2), 'utf8');
}
