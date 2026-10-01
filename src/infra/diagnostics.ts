import { execFile } from 'node:child_process';
import { basename, extname, relative } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Fast syntax checks run right after a file is written, so the model learns
 * about a broken edit in the same tool result instead of several turns later.
 *
 * Deliberately conservative: only parsers that cannot produce false positives
 * from missing project context (no type-checking, no import resolution), a
 * hard timeout, and silence whenever a checker is unavailable or inconclusive.
 * A clean file adds nothing to the tool result.
 */

const CHECK_TIMEOUT_MS = 5_000;
const MAX_CHECKED_CHARS = 1_000_000;
const MAX_ISSUES = 5;
const MAX_ISSUE_CHARS = 240;

export interface SyntaxIssue {
  checker: string;
  issues: string[];
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
  timedOut: boolean;
}

async function run(command: string, args: string[], cwd: string): Promise<RunResult> {
  // NODE_OPTIONS can carry loaders (e.g. --import tsx) that would slow or break a bare syntax check.
  const env = { ...process.env };
  delete env['NODE_OPTIONS'];
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd, timeout: CHECK_TIMEOUT_MS, maxBuffer: 256 * 1024, env, windowsHide: true,
    });
    return { code: 0, stdout, stderr, missing: false, timedOut: false };
  } catch (error) {
    const err = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    return {
      code: typeof err.code === 'number' ? err.code : null,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      missing: err.code === 'ENOENT',
      timedOut: err.killed === true,
    };
  }
}

const clip = (line: string): string => (line.length > MAX_ISSUE_CHARS ? `${line.slice(0, MAX_ISSUE_CHARS)}…` : line);

// ── per-language checkers ───────────────────────────────────────────────────

/** JSON files that legitimately contain comments or trailing commas. */
function allowsJsonComments(path: string): boolean {
  const name = basename(path).toLowerCase();
  return /^(ts|js)config(\..+)?\.json$/.test(name) || /[\\/]\.vscode[\\/]/.test(path) || name === 'devcontainer.json';
}

function checkJson(path: string, content: string): SyntaxIssue | undefined {
  if (allowsJsonComments(path)) return undefined;
  try {
    JSON.parse(content);
    return undefined;
  } catch (error) {
    return { checker: 'JSON', issues: [error instanceof Error ? error.message : String(error)] };
  }
}

const PYTHON_CHECK = [
  'import ast, sys',
  'path = sys.argv[1]',
  'try:',
  '    ast.parse(open(path, encoding="utf-8").read(), path)',
  'except SyntaxError as e:',
  '    print(f"line {e.lineno}, col {e.offset}: {e.msg}")',
  '    sys.exit(1)',
].join('\n');

async function checkPython(path: string, cwd: string): Promise<SyntaxIssue | undefined> {
  for (const python of ['python3', 'python']) {
    const result = await run(python, ['-c', PYTHON_CHECK, path], cwd);
    if (result.missing) continue;
    if (result.code === 1 && result.stdout.trim()) return { checker: 'Python', issues: [result.stdout.trim()] };
    return undefined;
  }
  return undefined;
}

async function checkNode(path: string, cwd: string): Promise<SyntaxIssue | undefined> {
  const result = await run(process.execPath, ['--check', path], cwd);
  if (result.code === 0 || result.timedOut || !/SyntaxError/.test(result.stderr)) return undefined;
  const lines = result.stderr.split('\n');
  const message = lines.find((line) => line.startsWith('SyntaxError'))?.replace(/^SyntaxError:\s*/, '') ?? 'syntax error';
  // First stderr line is "<path>:<line>".
  const line = /:(\d+)\s*$/.exec(lines[0] ?? '')?.[1];
  return { checker: 'Node', issues: [`${line ? `line ${line}: ` : ''}${message}`] };
}

/** Syntax-only TypeScript check through the project's own `typescript` package. */
const TS_CHECK = `
let ts;
try { ts = require(require.resolve('typescript', { paths: [process.cwd()] })); } catch { process.exit(3); }
const file = process.argv[1];
const out = ts.transpileModule(require('fs').readFileSync(file, 'utf8'), {
  fileName: file, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true },
});
const errors = (out.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
for (const d of errors.slice(0, ${MAX_ISSUES})) {
  const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
  console.log((pos.line + 1) + ':' + (pos.character + 1) + ' ' + ts.flattenDiagnosticMessageText(d.messageText, ' '));
}
process.exit(errors.length ? 1 : 0);
`;

async function checkTypeScript(path: string, cwd: string): Promise<SyntaxIssue | undefined> {
  const result = await run(process.execPath, ['-e', TS_CHECK, path], cwd);
  if (result.code !== 1 || !result.stdout.trim()) return undefined; // 3 = no typescript installed: stay silent
  return { checker: 'TypeScript', issues: result.stdout.trim().split('\n') };
}

async function checkShell(path: string, cwd: string): Promise<SyntaxIssue | undefined> {
  const result = await run('bash', ['-n', path], cwd);
  if (result.missing || result.timedOut || result.code === 0 || !result.stderr.trim()) return undefined;
  return { checker: 'bash -n', issues: result.stderr.trim().split('\n').map((line) => line.replace(`${path}: `, '')) };
}

// ── entry point ─────────────────────────────────────────────────────────────

const NODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.jsx']);

export async function findSyntaxIssue(absolutePath: string, content: string, cwd: string): Promise<SyntaxIssue | undefined> {
  if (process.env['AGENT_SYNTAX_CHECK'] === '0' || content.length > MAX_CHECKED_CHARS) return undefined;
  const ext = extname(absolutePath).toLowerCase();
  try {
    if (ext === '.json') return checkJson(absolutePath, content);
    if (ext === '.py') return await checkPython(absolutePath, cwd);
    if (NODE_EXTENSIONS.has(ext)) return await checkNode(absolutePath, cwd);
    if (TS_EXTENSIONS.has(ext)) return await checkTypeScript(absolutePath, cwd);
    if (ext === '.sh' || ext === '.bash') return await checkShell(absolutePath, cwd);
  } catch {
    // A diagnostic must never turn a successful write into a failure.
  }
  return undefined;
}

export function formatSyntaxIssue(issue: SyntaxIssue, absolutePath: string, cwd: string): string {
  const shown = relative(cwd, absolutePath) || absolutePath;
  const lines = issue.issues.slice(0, MAX_ISSUES).map((line) => `  ${clip(line)}`);
  const more = issue.issues.length > MAX_ISSUES ? `\n  … and ${issue.issues.length - MAX_ISSUES} more` : '';
  return `⚠ Syntax check failed (${issue.checker}) in ${shown}:\n${lines.join('\n')}${more}\nThe file was saved as written. Fix this before relying on it.`;
}

/** Put a diagnostic right after the first block of a tool result so a long diff cannot push it out of view. */
export function insertAfterFirstBlock(result: string, block: string): string {
  const split = result.indexOf('\n\n');
  return split === -1 ? `${result}\n\n${block}` : `${result.slice(0, split)}\n\n${block}${result.slice(split)}`;
}

/** Append a syntax diagnostic to a successful write result; a clean or unchecked file returns the result unchanged. */
export async function appendSyntaxCheck(result: string, absolutePath: string, content: string, cwd: string): Promise<string> {
  if (!result.startsWith('OK:')) return result;
  const issue = await findSyntaxIssue(absolutePath, content, cwd);
  return issue ? insertAfterFirstBlock(result, formatSyntaxIssue(issue, absolutePath, cwd)) : result;
}
