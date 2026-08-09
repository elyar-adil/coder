import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * HumanEval adapter + evaluator.
 *
 * Data format (one JSON object per line in HumanEval.jsonl):
 *   task_id, prompt (signature + docstring), entry_point, canonical_solution, test
 *
 * The agent only ever sees the `prompt` field (signature + docstring). The
 * `test` field (a `def check(candidate): ...` block) is held back and injected
 * by the evaluator after the agent finishes — this is what makes it a hidden
 * test set rather than a self-graded exercise.
 */

export interface HumanEvalItem {
  task_id: string;          // "HumanEval/0"
  prompt: string;           // signature + docstring, ends after docstring close
  entry_point: string;      // function name
  canonical_solution: string;
  test: string;             // "def check(candidate): ..." block
}

export async function loadHumanEval(
  path = 'tests/benchmarks/datasets/humaneval/HumanEval.jsonl',
  limit?: number,
): Promise<HumanEvalItem[]> {
  const raw = await readFile(path, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const items = lines.map((line) => JSON.parse(line) as HumanEvalItem);
  return limit ? items.slice(0, limit) : items;
}

/** What goes into solution.py before the agent starts. */
export function starterCode(item: HumanEvalItem): string {
  // The prompt field already ends right after the docstring; give the body a
  // `pass` placeholder so the file is importable and editable.
  return `${item.prompt}    pass\n`;
}

/**
 * Build the instruction text handed to the agent. We inline the current file
 * contents so the agent doesn't have to read it (read_file resolves relative
 * paths against process.cwd(), not the artifact dir — inlining sidesteps that).
 * edit_file with path "solution.py" resolves correctly into the workdir.
 */
export function buildAgentPrompt(item: HumanEvalItem, workdir: string): string {
  return [
    `Solve the Python programming task below.`,
    ``,
    `Working directory: ${workdir}`,
    `The file solution.py already exists with the function signature and docstring. Its current content is:`,
    ``,
    '```python',
    starterCode(item).trimEnd(),
    '```',
    ``,
    `Your job:`,
    `1. Implement the function \`${item.entry_point}\` by replacing the \`pass\` placeholder with a correct body.`,
    `2. Do NOT change the function signature, imports, or docstring.`,
    `3. Use the edit_file tool with path "solution.py" to make the change (edits is a JSON array of {search, replace}).`,
    `4. Verify your work by running \`python -c "import solution"\` via the bash tool to check for syntax/import errors. You may also write quick ad-hoc checks, but do not modify the public function signature.`,
    `5. Keep the implementation minimal and correct. Do not create extra files.`,
    ``,
    `When done, reply with a one-line summary of your implementation.`,
  ].join('\n');
}

export type Verdict = 'pass' | 'fail_assert' | 'fail_load' | 'fail_no_solution' | 'fail_eval_error';

export interface EvalResult {
  verdict: Verdict;
  pass: boolean;
  output: string;
  error?: string;
}

const TEST_HARNESS = (entryPoint: string, testB64: string) => `import base64, os, sys, traceback
_here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(_here, "solution.py")) as _f:
    _sol = _f.read()
_g = {}
try:
    exec(_sol, _g)
except Exception:
    traceback.print_exc()
    sys.exit(2)
_candidate = _g.get(${JSON.stringify(entryPoint)})
if _candidate is None:
    print("FAIL: function ${entryPoint} not found in solution.py")
    sys.exit(3)
_test = base64.b64decode(${JSON.stringify(testB64)}).decode("utf-8")
try:
    exec(_test, _g)
except Exception:
    traceback.print_exc()
    sys.exit(4)
try:
    _g["check"](_candidate)
    print("PASS")
    sys.exit(0)
except Exception:
    traceback.print_exc()
    sys.exit(1)
`;

/**
 * Run the hidden test against the agent's solution.py. Exit codes:
 *   0 = pass, 1 = assertion failure, 2 = solution failed to load/import,
 *   3 = entry point missing, 4 = test harness itself errored.
 */
export async function evaluateSolution(
  workdir: string,
  item: HumanEvalItem,
): Promise<EvalResult> {
  const testB64 = Buffer.from(item.test, 'utf8').toString('base64');
  const harness = TEST_HARNESS(item.entry_point, testB64);
  const harnessPath = join(workdir, '__test__.py');
  await writeFile(harnessPath, harness, 'utf8');

  try {
    const { stdout, stderr } = await execAsync('python __test__.py', {
      cwd: workdir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024 * 2,
    });
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    // The harness prints "PASS" on success; rely on stdout content rather than
    // exit code alone (Windows cmd can surface non-zero codes spuriously).
    const pass = stdout.includes('PASS') && !stdout.includes('Traceback');
    return {
      verdict: pass ? 'pass' : 'fail_assert',
      pass,
      output,
    };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; code?: number | string; message?: string };
    const stdout = err.stdout ?? '';
    const stderr = err.stderr ?? '';
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    // Even if exec threw (non-zero exit), a PASS in stdout means the checks ran
    // and passed — trust the protocol string over the exit code.
    if (stdout.includes('PASS') && !stdout.includes('Traceback')) {
      return { verdict: 'pass', pass: true, output };
    }
    const code = typeof err.code === 'number' ? err.code : Number(err.code);
    let verdict: Verdict = 'fail_eval_error';
    if (code === 1) verdict = 'fail_assert';
    else if (code === 2) verdict = 'fail_load';
    else if (code === 3) verdict = 'fail_no_solution';
    else if (code === 4) verdict = 'fail_eval_error';
    return {
      verdict,
      pass: false,
      output,
      error: err.message ?? String(e),
    };
  }
}
