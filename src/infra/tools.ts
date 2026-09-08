import { readFile, writeFile, readdir, mkdir, stat, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolDefinition, ToolExecutionContext, ToolMetadata } from '../tools/types.js';
import { unifiedDiff } from '../diff.js';
import { resilientFetch } from '../fetch.js';
import { snapshotBeforeWrite } from './file-snapshot.js';
import {
  authorizeToolCall,
  clonePolicy,
  defaultPolicy,
  formatPolicyError,
  type ToolPolicy,
} from '../policy.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
export type BuiltinToolContext = ToolExecutionContext<ToolPolicy>;

function workspaceRoot(ctx?: BuiltinToolContext): string {
  return resolve(ctx?.workspaceRoot ?? ctx?.policy?.workspaceRoot ?? process.cwd());
}

function resolveToolPath(targetPath: string, ctx?: BuiltinToolContext): string {
  return isAbsolute(targetPath) ? resolve(targetPath) : resolve(workspaceRoot(ctx), targetPath);
}

async function gitAutoCommit(filePath: string, message: string, ctx?: BuiltinToolContext): Promise<void> {
  if (process.env.AGENT_AUTO_COMMIT !== '1') return;
  try {
    const cwd = workspaceRoot(ctx);
    await execFileAsync('git', ['add', '--', filePath], { timeout: 15_000, cwd, signal: ctx?.signal });
    await execFileAsync('git', ['commit', '-m', message, '--no-verify'], { timeout: 15_000, cwd, signal: ctx?.signal });
  } catch {
    // Best-effort only.
  }
}

function artifactRelativePath(targetPath: string): string | undefined {
  const normalized = targetPath.replace(/\\/g, '/');
  if (!normalized || /^[a-z][a-z0-9+.-]*:/i.test(normalized) || normalized.startsWith('/') || normalized.startsWith('~/') || normalized.startsWith('../')) return undefined;
  if (/^\.[/\\]/.test(targetPath)) return undefined;
  if (normalized.includes('/../') || normalized === '..') return undefined;
  return normalized;
}

function resolveWriteTarget(targetPath: string, ctx?: BuiltinToolContext): string {
  const artifactDir = ctx?.artifactDir;
  const artifactRel = artifactDir ? artifactRelativePath(targetPath) : undefined;
  if (artifactDir && artifactRel) return resolve(artifactDir, artifactRel);
  return resolveToolPath(targetPath, ctx);
}

function authorizeWithResolvedPath(policy: ToolPolicy, name: string, path: string, ctx?: BuiltinToolContext): string | undefined {
  const target = resolveWriteTarget(path, ctx);
  const decision = authorizeToolCall(policy, name, { path: target });
  return decision.ok ? undefined : formatPolicyError(name, decision);
}

async function writeViaWorkspace(targetPath: string, content: string, ctx?: BuiltinToolContext): Promise<string> {
  const absoluteTarget = resolveWriteTarget(targetPath, ctx);
  const root = workspaceRoot(ctx);
  const rel = absoluteTarget.startsWith(root)
    ? relative(root, absoluteTarget)
    : join('__external__', absoluteTarget.replace(/^([a-zA-Z]:)?[/\\]+/, ''));
  const workspacePath = join(root, '.agent-workspace', rel);
  await mkdir(dirname(workspacePath), { recursive: true });
  await atomicWrite(workspacePath, content);
  await mkdir(dirname(absoluteTarget), { recursive: true });
  await atomicWrite(absoluteTarget, content);
  return absoluteTarget;
}

/**
 * Staged, all-or-nothing write: content goes to a staging file next to the
 * target, is verified from disk, and only then is atomically swapped in via
 * rename. The target is never observable in a partially written or unverified
 * state, and any failure (including failed readback verification) leaves the
 * target byte-for-byte unchanged — no post-failure restore pass needed.
 */
async function stagedWrite(
  path: string,
  content: string,
  ctx: BuiltinToolContext | undefined,
  verify: (written: string) => Promise<void> | void,
): Promise<string> {
  const absoluteTarget = resolveWriteTarget(path, ctx);
  const root = workspaceRoot(ctx);
  const rel = absoluteTarget.startsWith(root)
    ? relative(root, absoluteTarget)
    : join('__external__', absoluteTarget.replace(/^([a-zA-Z]:)?[/\\]+/, ''));
  const workspacePath = join(root, '.agent-workspace', rel);
  const staging = `${absoluteTarget}.${process.pid}.${randomUUID()}.staging`;
  await mkdir(dirname(absoluteTarget), { recursive: true });
  try {
    await writeFile(staging, content, 'utf8');
    const written = await readFile(staging, 'utf8');
    await verify(written);
    await mkdir(dirname(workspacePath), { recursive: true });
    await atomicWrite(workspacePath, content);
    await rename(staging, absoluteTarget);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
  return absoluteTarget;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, content, 'utf8');
  try {
    await rename(temp, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EPERM', 'EEXIST', 'EACCES'].includes(code ?? '')) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    await rm(path, { force: true });
    await rename(temp, path);
  }
}

const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  '.ts': [
    /^export\s+(?:async\s+)?(?:function|class|interface|type|enum|const|let)\s+(\w+)/m,
    /^(?:async\s+)?(?:function|class)\s+(\w+)/m,
  ],
  '.tsx': [
    /^export\s+(?:async\s+)?(?:function|class|interface|type|const)\s+(\w+)/m,
  ],
  '.js': [
    /^(?:export\s+)?(?:async\s+)?(?:function|class|const)\s+(\w+)/m,
  ],
  '.py': [
    /^(?:async\s+)?def\s+(\w+)/m,
    /^class\s+(\w+)/m,
  ],
  '.rs': [
    /^pub\s+(?:async\s+)?fn\s+(\w+)/m,
    /^pub\s+struct\s+(\w+)/m,
    /^pub\s+enum\s+(\w+)/m,
  ],
  '.go': [
    /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/m,
    /^type\s+(\w+)\s+struct/m,
  ],
  '.lua': [
    /^(?:local\s+)?function\s+(\w+)/m,
  ],
};

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  'target',
  '.cache',
  'coverage',
  '.nyc_output',
]);

async function extractFileSymbols(filePath: string): Promise<string[]> {
  const ext = extname(filePath);
  const patterns = SYMBOL_PATTERNS[ext];
  if (!patterns) return [];
  try {
    const src = await readFile(filePath, 'utf8');
    const symbols: string[] = [];
    for (const line of src.split('\n')) {
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match?.[1] && !symbols.includes(match[1])) {
          symbols.push(match[1]);
        }
      }
    }
    return symbols;
  } catch {
    return [];
  }
}

async function walkDir(
  dir: string,
  maxDepth: number,
  depth = 0,
): Promise<Array<{ path: string; symbols: string[] }>> {
  if (depth > maxDepth) return [];
  const results: Array<{ path: string; symbols: string[] }> = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name)) continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        results.push(...await walkDir(full, maxDepth, depth + 1));
        continue;
      }
      if (!entry.isFile() || !SYMBOL_PATTERNS[extname(entry.name)]) continue;
      results.push({ path: full, symbols: await extractFileSymbols(full) });
    }
  } catch {
    return [];
  }
  return results;
}

// ── Deterministic edit matching ──────────────────────────────────────────────
//
// LLMs frequently produce search strings with minor whitespace or indentation
// drift. We attempt deterministic normalization strategies in order — never
// similarity guessing — and require every candidate match to be unique in the
// file, reporting actionable errors on no-match or ambiguity.

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let idx = haystack.indexOf(needle); idx !== -1; idx = haystack.indexOf(needle, idx + 1)) {
    count += 1;
  }
  return count;
}

function lineNumbersOf(haystack: string, needle: string, limit: number): number[] {
  const lines: number[] = [];
  for (let idx = haystack.indexOf(needle); idx !== -1 && lines.length < limit; idx = haystack.indexOf(needle, idx + 1)) {
    lines.push(haystack.slice(0, idx).split('\n').length);
  }
  return lines;
}

function closestLineHints(content: string, search: string): number[] {
  const firstLine = search.split('\n').find((line) => line.trim())?.trim() ?? '';
  if (!firstLine) return [];
  const hints = lineNumbersOf(content, firstLine, 3);
  if (hints.length > 0 || firstLine.length <= 24) return hints;
  return lineNumbersOf(content, firstLine.slice(0, 24), 3);
}

function normalizedForSimilarity(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[\t ]+/g, ' ').trim();
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

function closestMatch(content: string, search: string): { line: number; matched: string; similarity: number } | undefined {
  const requested = search.split('\n');
  const lines = content.split('\n');
  const count = requested.length;
  if (!search.trim() || !lines.length) return undefined;
  let best: { line: number; matched: string; similarity: number } | undefined;
  for (let i = 0; i <= lines.length - count; i += 1) {
    const matched = lines.slice(i, i + count).join('\n');
    const left = normalizedForSimilarity(search);
    const right = normalizedForSimilarity(matched);
    const max = Math.max(left.length, right.length, 1);
    const similarity = 1 - editDistance(left, right) / max;
    if (!best || similarity > best.similarity) best = { line: i + 1, matched, similarity };
  }
  return best;
}

function diagnosticDiff(requested: string, matched: string): string {
  const requestedLines = requested.split('\n');
  const matchedLines = matched.split('\n');
  const lines = ['```diff', '- requested'];
  lines.push(...requestedLines.map((line) => `- ${line}`));
  lines.push('+ matched');
  lines.push(...matchedLines.map((line) => `+ ${line}`));
  lines.push('```');
  return lines.join('\n');
}

function stripReadFileLineNumbers(search: string): string | undefined {
  const lines = search.split('\n');
  const contentLines = lines.filter((line) => !line.startsWith('... (showing lines '));
  if (contentLines.length === 0) return undefined;
  const hasLineNumbers = contentLines.every((line) => /^\d{5}\|/.test(line));
  if (!hasLineNumbers) return undefined;
  return contentLines.map((line) => line.replace(/^\d{5}\|/, '')).join('\n');
}

function stripCommonIndent(s: string): string {
  const lines = s.split('\n');
  const minIndent = lines
    .filter((l) => l.trim())
    .reduce((min, l) => Math.min(min, l.match(/^\s*/)?.[0].length ?? 0), Infinity);
  return lines.map((l) => l.slice(minIndent === Infinity ? 0 : minIndent)).join('\n');
}

function unescapeEscapes(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

type UniqueMatchResult =
  | { kind: 'ok'; matched: string; strategy: string }
  | { kind: 'ambiguous'; matched: string; count: number; lines: number[] }
  | { kind: 'none' };

function findUniqueMatch(content: string, search: string): UniqueMatchResult {
  const exactCount = countOccurrences(content, search);
  if (exactCount === 1) return { kind: 'ok', matched: search, strategy: 'exact' };
  if (exactCount > 1) {
    return { kind: 'ambiguous', matched: search, count: exactCount, lines: lineNumbersOf(content, search, 5) };
  }

  const contentLines = content.split('\n');
  const searchLineCount = search.split('\n').length;
  const searchTrimmed = search.split('\n').map((l) => l.trim()).join('\n');
  const searchNorm = search.replace(/[\t ]+/g, ' ').trim();
  const searchStripped = stripCommonIndent(search);
  const searchEsc = unescapeEscapes(search);
  const searchTrimBound = search.trim();
  const strategies: Array<{ name: string; matches: (window: string) => boolean }> = [
    { name: 'line-trimmed', matches: (w) => w.split('\n').map((l) => l.trim()).join('\n') === searchTrimmed },
    { name: 'whitespace-normalized', matches: (w) => w.replace(/[\t ]+/g, ' ').trim() === searchNorm },
    { name: 'indentation-flexible', matches: (w) => stripCommonIndent(w) === searchStripped },
    { name: 'escape-normalized', matches: (w) => unescapeEscapes(w) === searchEsc },
    { name: 'trim-boundaries', matches: (w) => w.trim() === searchTrimBound },
  ];
  for (const { name, matches } of strategies) {
    for (let i = 0; i <= contentLines.length - searchLineCount; i++) {
      const window = contentLines.slice(i, i + searchLineCount).join('\n');
      if (!matches(window)) continue;
      const count = countOccurrences(content, window);
      if (count === 1) return { kind: 'ok', matched: window, strategy: name };
      return { kind: 'ambiguous', matched: window, count, lines: lineNumbersOf(content, window, 5) };
    }
  }
  return { kind: 'none' };
}

let defaultToolPolicy: ToolPolicy = defaultPolicy();

export function setToolPolicy(policy: ToolPolicy): void {
  defaultToolPolicy = clonePolicy(policy);
}

export function getToolPolicy(): ToolPolicy {
  return clonePolicy(defaultToolPolicy);
}

async function withWriteLock<T>(
  ctx: BuiltinToolContext | undefined,
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  const release = await ctx?.acquireWriteLock?.(path);
  try {
    return await action();
  } finally {
    await release?.();
  }
}

/** Backward-compatible provider name; the schema is provider-neutral. */
export type OllamaToolDef = ToolDefinition;

export const TOOLS: OllamaToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read file content from disk. Returns line-numbered output (5-digit padded line numbers). Always call this before writing to an existing file. Use offset/limit to read large files in sections.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' },
          offset: { type: 'number', description: '1-based line number to start reading from (optional)' },
          limit: { type: 'number', description: 'Maximum number of lines to read (optional)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: `Apply one or more targeted search-replace edits to an existing file.
Each edit must match the file exactly; every match is required to be unique.
Use this instead of write_file when modifying an existing file — it is safer
and preserves surrounding context.

Format: provide a JSON array of {search, replace} pairs.
- "search" must be an exact substring of the current file content (including indentation/newlines).
  Minor whitespace/indentation drift and literal \\n escapes are normalized deterministically,
  but near-miss guesses are never accepted.
- "replace" is the new content that replaces it.
- Edits are applied in order; each operates on the result of the previous.
- To delete a block, set "replace" to "".
- Multiple matches fail; add surrounding context to disambiguate, or set replaceAll to true.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to edit' },
          edits: { type: 'string', description: 'JSON array of {search, replace} objects' },
          expectedReplacements: { type: 'number', description: 'Expected number of occurrences to replace per edit (default 1). The actual count must equal this or the edit fails with the actual count.' },
          replaceAll: { type: 'boolean', description: 'Replace every occurrence of each search string (default false)' },
        },
        required: ['path', 'edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repo_map',
      description: `Generate a concise symbol map of the repository — files and their top-level
exported symbols (functions, classes, types, etc.). Use this at the start of a task to
understand the codebase structure without reading every file. Returns a compact text outline.`,
      parameters: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Root directory to scan (default: ".")' },
          max_depth: { type: 'string', description: 'Max directory depth to walk (default: "6")' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with complete content. Always provide the full file — never a partial diff.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' },
          content: { type: 'string', description: 'Complete file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and subdirectories inside a directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_files',
      description: 'Read several files in one call. Returns independently labelled, line-numbered sections and continues when one file is missing.',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', description: 'File paths to read', items: { type: 'string' } },
          max_lines: { type: 'number', description: 'Maximum lines per file (default 400)' },
        },
        required: ['paths'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_info',
      description: 'Return safe metadata for a file or directory without reading its contents.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File or directory path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description: '在仓库中搜索文本或正则表达式，返回紧凑的文件、行号和匹配内容。优先使用本工具而不是 bash rg。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索文本或正则表达式' },
          path: { type: 'string', description: '搜索根目录，默认当前目录' },
          glob: { type: 'string', description: '可选文件 glob，例如 *.ts' },
          max_results: { type: 'number', description: '最大结果数，默认 100' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '按 glob 列出仓库文件，自动忽略 .git 和 node_modules。',
      parameters: {
        type: 'object',
        properties: {
          glob: { type: 'string', description: '文件 glob，例如 **/*.ts' },
          path: { type: 'string', description: '搜索根目录，默认当前目录' },
          max_results: { type: 'number', description: '最大结果数，默认 200' },
        },
        required: ['glob'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '在互联网上搜索网页，返回标题、链接和摘要。用于需要最新信息、外部资料或超出本地仓库知识的问题。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词或问题' },
          max_results: { type: 'number', description: '最大结果数，默认 8，最大 20' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: '返回当前仓库的紧凑 Git 状态。只读。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: '返回工作树或暂存区差异，可限制文件。只读。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '可选文件路径' },
          staged: { type: 'boolean', description: '是否查看暂存区差异' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'Show recent commits with subject, author and date. Read-only and optionally scoped to a path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional repository-relative path' },
          max_count: { type: 'number', description: 'Maximum commits (default 20, max 100)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: process.platform === 'win32'
        ? 'Execute a shell command and return stdout + stderr. Use for builds, tests, git, installs, etc. NOTE: on Windows this runs cmd.exe — Unix tools like grep/sed/awk/ripgrep are unavailable; use the built-in search_text/read_file tools instead.'
        : 'Execute a shell command and return stdout + stderr. Use for builds, tests, git, installs, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: '可选工作目录' },
          timeout_ms: { type: 'number', description: '超时毫秒数，默认 60000，最大 300000' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: 'Load a reusable skill definition by name. Skills provide domain-specific instructions, conventions, and project structure guidelines.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name to load' },
        },
        required: ['name'],
      },
    },
  },
];

export const WORKER_TOOLS = TOOLS;

const TOOL_METADATA: Record<string, ToolMetadata> = {
  read_file: { effect: 'read', category: 'filesystem' },
  read_files: { effect: 'read', category: 'filesystem' },
  file_info: { effect: 'read', category: 'filesystem' },
  edit_file: { effect: 'write', category: 'filesystem' },
  write_file: { effect: 'write', category: 'filesystem' },
  list_dir: { effect: 'read', category: 'filesystem' },
  repo_map: { effect: 'read', category: 'search' },
  search_text: { effect: 'read', category: 'search' },
  search_files: { effect: 'read', category: 'search' },
  web_search: { effect: 'execute', category: 'web' },
  git_status: { effect: 'read', category: 'git' },
  git_diff: { effect: 'read', category: 'git' },
  git_log: { effect: 'read', category: 'git' },
  bash: { effect: 'execute', category: 'shell' },
  load_skill: { effect: 'read', category: 'agent' },
};

function parseStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : undefined;
  } catch {
    return undefined;
  }
}

function formatLineRange(raw: string, offset = 1, limit?: number): string {
  if (raw === '') return '';
  const allLines = raw.split('\n');
  const totalLines = allLines.length;
  const startLine = Math.max(1, Math.min(offset, totalLines));
  const endLine = limit !== undefined ? Math.min(startLine + Math.max(1, limit) - 1, totalLines) : totalLines;
  const numbered = allLines.slice(startLine - 1, endLine).map((line, index) => (
    `${String(startLine + index).padStart(5, '0')}|${line}`
  )).join('\n');
  return endLine < totalLines
    ? `${numbered}\n... (showing lines ${startLine}-${endLine} of ${totalLines}; use offset/limit to read more)`
    : numbered;
}

async function readLineRange(filePath: string, offset = 1, limit?: number): Promise<string> {
  return formatLineRange(await readFile(filePath, 'utf8'), offset, limit);
}

function boundedOutput(value: string, maxChars = 4 * 1024 * 1024): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n... (output truncated at ${maxChars} characters)`;
}

function contentVersion(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ── Pure-Node search fallback (used when `rg` is not installed) ──────────────
// Mirrors the rg invocations in `search_text`/`search_files`: hidden files are
// included, only `.git` and `node_modules` are skipped.

const SEARCH_IGNORE_DIRS = new Set(['.git', 'node_modules']);

function forwardSlash(path: string): string {
  return path.replace(/\\/g, '/');
}

function trimSnippet(line: string, max = 300): string {
  const text = line.replace(/\s+$/g, '');
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/** Convert a common glob (**, *, ?) into an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  const sentinel: Array<[RegExp, string]> = [
    [/\*\*\//g, '\u0001'],
    [/\*\*/g, '\u0002'],
    [/\*/g, '\u0003'],
    [/\?/g, '\u0004'],
  ];
  let source = forwardSlash(glob);
  for (const [re, token] of sentinel) source = source.replace(re, token);
  source = source.replace(/([.+^${}()|[\]\\])/g, '\\$&');
  source = source
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*')
    .replace(/\u0003/g, '[^/]*')
    .replace(/\u0004/g, '[^/]');
  return new RegExp(`^${source}$`);
}

function globMatches(glob: string, filePath: string, root: string): boolean {
  const rel = forwardSlash(relative(root, filePath));
  if (glob.includes('/')) return globToRegExp(glob).test(rel);
  const re = globToRegExp(glob);
  return re.test(basename(rel)) || re.test(rel);
}

async function walkAllFiles(root: string, signal?: AbortSignal, maxFiles = 200_000): Promise<string[]> {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    if (signal?.aborted) throw new Error('search aborted');
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return files;
      if (SEARCH_IGNORE_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

export async function searchTextFallback(
  root: string,
  query: string,
  glob: string | undefined,
  max: number,
  signal?: AbortSignal,
): Promise<string[]> {
  let pattern: RegExp;
  try {
    pattern = new RegExp(query, 'm');
  } catch {
    pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm');
  }
  const files = await walkAllFiles(root, signal);
  const results: string[] = [];
  for (const file of files) {
    if (signal?.aborted) throw new Error('search aborted');
    if (results.length >= max) break;
    if (glob && !globMatches(glob, file, root)) continue;
    let statInfo;
    try {
      statInfo = await stat(file);
    } catch {
      continue;
    }
    if (statInfo.size > 8 * 1024 * 1024) continue;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length && results.length < max; index++) {
      if (pattern.test(lines[index]!)) {
        results.push(`${forwardSlash(relative(root, file))}:${index + 1}:${trimSnippet(lines[index]!)}`);
      }
    }
  }
  return results;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('search aborted');
}

async function searchFilesFallback(
  root: string,
  glob: string,
  max: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const files = await walkAllFiles(root, signal);
  const matches: string[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    if (matches.length >= max) break;
    if (!globMatches(glob, file, root)) continue;
    matches.push(forwardSlash(relative(root, file)));
  }
  return matches;
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeHtmlEntities(input: string): string {
  const namedEntities: Record<string, string> = {
    ensp: ' ', emsp: '  ', thinsp: ' ', middot: '·', ndash: '–', mdash: '—',
    hellip: '…', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    copy: '©', reg: '®', trade: '™', bull: '•', deg: '°', plusmn: '±', times: '×', divide: '÷',
  };
  return input
    .replace(/&#x([0-9a-f]+);?/gi, (_match, value: string) => {
      const codePoint = Number.parseInt(value, 16);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : _match;
    })
    .replace(/&#(\d+);?/g, (_match, value: string) => {
      const codePoint = Number.parseInt(value, 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : _match;
    })
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&([a-z][a-z0-9]+);/gi, (match, name: string) => namedEntities[name.toLowerCase()] ?? match)
    .replace(/&amp;/g, '&');
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function ddgRealUrl(href: string): string {
  const redirect = /[?&]uddg=([^&]+)/.exec(href ?? '');
  if (redirect?.[1]) {
    try {
      return decodeURIComponent(redirect[1]);
    } catch {
      return href;
    }
  }
  return href.startsWith('//') ? `https:${href}` : href;
}

function bingRealUrl(href: string): string {
  const value = href ?? '';
  const encoded = /[?&]u=([^&]+)/.exec(value)?.[1];
  if (encoded) {
    try {
      const decoded = decodeURIComponent(encoded);
      if (decoded.startsWith('a1')) {
        const payload = decoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
        const target = Buffer.from(padded, 'base64').toString('utf8');
        if (/^https?:\/\//i.test(target)) return target;
      }
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      // Keep the provider URL when redirect decoding fails.
    }
  }
  return value.startsWith('//') ? `https:${value}` : value;
}

function parseDdgResults(html: string, max: number, signal?: AbortSignal): WebSearchResult[] {
  const titles: Array<{ title: string; url: string }> = [];
  const titleRe = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(titleRe)) {
    throwIfAborted(signal);
    const title = collapseWhitespace(stripTags(decodeHtmlEntities(match[2] ?? '')));
    if (!title) continue;
    titles.push({ title, url: ddgRealUrl(decodeHtmlEntities(match[1] ?? '')) });
    if (titles.length >= max) break;
  }

  const snippets: string[] = [];
  const snippetRe = /<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(snippetRe)) {
    snippets.push(collapseWhitespace(stripTags(decodeHtmlEntities(match[1] ?? ''))));
    if (snippets.length >= titles.length) break;
  }
  return titles.map((item, index) => ({ ...item, snippet: snippets[index] ?? '' }));
}

function parseBingResults(html: string, max: number, signal?: AbortSignal): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const itemRe = /<li[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  for (const item of html.matchAll(itemRe)) {
    throwIfAborted(signal);
    const block = item[1] ?? '';
    const titleMatch = /<h2[^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i.exec(block);
    if (!titleMatch) continue;
    const title = collapseWhitespace(stripTags(decodeHtmlEntities(titleMatch[2] ?? '')));
    if (!title) continue;
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    results.push({
      title,
      url: bingRealUrl(decodeHtmlEntities(titleMatch[1] ?? '')),
      snippet: collapseWhitespace(stripTags(decodeHtmlEntities(snippetMatch?.[1] ?? ''))),
    });
    if (results.length >= max) break;
  }
  return results;
}

interface SearchProvider {
  name: string;
  url: string;
  parse: (html: string, max: number, signal?: AbortSignal) => WebSearchResult[];
}

const SEARCH_PROVIDERS: SearchProvider[] = [
  {
    name: 'Bing',
    url: 'https://www.bing.com/search?q=',
    parse: parseBingResults,
  },
  {
    name: 'DuckDuckGo',
    url: 'https://html.duckduckgo.com/html/?q=',
    parse: parseDdgResults,
  },
];

async function searchWeb(
  query: string,
  max: number,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const errors: string[] = [];
  for (const provider of SEARCH_PROVIDERS) {
    throwIfAborted(signal);
    try {
      const response = await resilientFetch(
        `${provider.url}${encodeURIComponent(query)}${provider.name === 'Bing' ? `&count=${max}` : ''}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.8',
          },
          retries: 0,
          timeout: 10_000,
          signal,
        },
      );
      const html = await response.text();
      const results = provider.parse(html, max, signal);
      if (results.length > 0) return results;
      errors.push(`${provider.name}: no results returned`);
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${provider.name}: ${message}`);
    }
  }
  throw new Error(`all web search providers failed (${errors.join('; ')})`);
}

async function executeBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: BuiltinToolContext,
): Promise<string> {
  const policy = ctx?.policy ?? getToolPolicy();
  const decision = authorizeToolCall(policy, name, args);
  if (!decision.ok) return formatPolicyError(name, decision);

  switch (name) {
    case 'search_text': {
      const query = typeof args['query'] === 'string' ? args['query'] : '';
      if (!query) return JSON.stringify({ ok: false, error: 'query is required' });
      const root = resolveToolPath(typeof args['path'] === 'string' ? args['path'] : '.', ctx);
      const max = Math.max(1, Math.min(Number(args['max_results'] ?? 100), 500));
      const glob = typeof args['glob'] === 'string' ? args['glob'] : undefined;
      try {
        const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '--hidden', '--glob', '!.git', '--glob', '!node_modules', ...(glob ? ['--glob', glob] : []), query, root];
        const result = await execFileAsync('rg', rgArgs, { cwd: workspaceRoot(ctx), maxBuffer: 1024 * 1024 * 2, timeout: 30_000, signal: ctx?.signal });
        const lines = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, max);
        return JSON.stringify({ ok: true, results: lines, truncated: lines.length >= max });
      } catch (error: any) {
        if (error?.code === 1) return JSON.stringify({ ok: true, results: [], truncated: false });
        try {
          const results = await searchTextFallback(root, query, glob, max, ctx?.signal);
          return JSON.stringify({ ok: true, results, truncated: results.length >= max });
        } catch (fallbackError: unknown) {
          const rgMessage = error?.message ?? String(error);
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          return JSON.stringify({ ok: false, error: fallbackMessage ? `${fallbackMessage} (rg: ${rgMessage})` : rgMessage });
        }
      }
    }
    case 'search_files': {
      const glob = typeof args['glob'] === 'string' ? args['glob'] : '*';
      const root = resolveToolPath(typeof args['path'] === 'string' ? args['path'] : '.', ctx);
      const max = Math.max(1, Math.min(Number(args['max_results'] ?? 200), 1000));
      try {
        const result = await execFileAsync('rg', ['--files', '--hidden', '--glob', '!.git', '--glob', '!node_modules', '--glob', glob, root], { cwd: workspaceRoot(ctx), maxBuffer: 1024 * 1024 * 2, timeout: 30_000, signal: ctx?.signal });
        const files = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, max);
        return JSON.stringify({ ok: true, files, truncated: files.length >= max });
      } catch (error: any) {
        if (error?.code === 1) return JSON.stringify({ ok: true, files: [], truncated: false });
        if (error?.code === 'ENOENT') {
          try {
            const files = await searchFilesFallback(root, glob, max, ctx?.signal);
            return JSON.stringify({ ok: true, files, truncated: files.length >= max });
          } catch (fallbackError: unknown) {
            return JSON.stringify({ ok: false, error: String(fallbackError instanceof Error ? fallbackError.message : fallbackError) });
          }
        }
        return JSON.stringify({ ok: false, error: String(error?.message ?? error) });
      }
    }
    case 'web_search': {
      const query = typeof args['query'] === 'string' ? args['query'] : '';
      if (!query) return JSON.stringify({ ok: false, error: 'query is required' });
      const requestedMax = Number(args['max_results'] ?? 8);
      const max = Number.isFinite(requestedMax)
        ? Math.max(1, Math.min(Math.floor(requestedMax), 20))
        : 8;
      try {
        const results = await searchWeb(query, max, ctx?.signal);
        return JSON.stringify({ ok: true, results, truncated: results.length >= max });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const friendly = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|DNS lookup failed|connection refused|connection reset|timeout|network/i.test(message)
          ? '网络不可达，无法完成网页搜索（请检查本机网络连接或代理设置）'
          : message;
        return JSON.stringify({ ok: false, error: friendly });
      }
    }
    case 'git_status': {
      try {
        const result = await execFileAsync('git', ['status', '--short', '--branch'], { cwd: workspaceRoot(ctx), timeout: 15_000, signal: ctx?.signal });
        return JSON.stringify({ ok: true, status: result.stdout.trim() });
      } catch (error: any) { return JSON.stringify({ ok: false, error: String(error?.message ?? error) }); }
    }
    case 'git_diff': {
      const path = typeof args['path'] === 'string' ? args['path'] : undefined;
      const staged = args['staged'] === true;
      try {
        const result = await execFileAsync('git', ['diff', ...(staged ? ['--cached'] : []), '--', ...(path ? [path] : [])], { cwd: workspaceRoot(ctx), maxBuffer: 1024 * 1024 * 4, timeout: 20_000, signal: ctx?.signal });
        return JSON.stringify({ ok: true, diff: result.stdout, truncated: false });
      } catch (error: any) { return JSON.stringify({ ok: false, error: String(error?.message ?? error) }); }
    }
    case 'read_file': {
      const path = typeof args['path'] === 'string' ? args['path'] : undefined;
      if (!path) return 'Error: read_file requires "path"';
      const offsetArg = typeof args['offset'] === 'number' ? args['offset'] : undefined;
      const limitArg = typeof args['limit'] === 'number' ? args['limit'] : undefined;
      try {
        const targetPath = resolveToolPath(path, ctx);
        const content = await readFile(targetPath, 'utf8');
        ctx?.recordReadVersion?.(targetPath, contentVersion(content));
        return formatLineRange(content, offsetArg, limitArg);
      } catch (error) {
        return `Error reading file: ${String(error)}`;
      }
    }

    case 'read_files': {
      const paths = parseStringArray(args['paths']);
      if (!paths?.length) return 'Error: read_files requires a non-empty "paths" array';
      if (paths.length > 50) return 'Error: read_files accepts at most 50 paths';
      const maxLines = Math.max(1, Math.min(Number(args['max_lines'] ?? 400), 5000));
      const sections: string[] = [];
      for (const path of paths) {
        const decision = authorizeToolCall(policy, 'read_file', { path });
        if (!decision.ok) {
          sections.push(`===== ${path} =====\n${formatPolicyError('read_files', decision)}`);
          continue;
        }
        try {
          const targetPath = resolveToolPath(path, ctx);
          const content = await readFile(targetPath, 'utf8');
          ctx?.recordReadVersion?.(targetPath, contentVersion(content));
          sections.push(`===== ${path} =====\n${formatLineRange(content, 1, maxLines)}`);
        } catch (error) {
          sections.push(`===== ${path} =====\nError reading file: ${String(error)}`);
        }
      }
      return boundedOutput(sections.join('\n\n'));
    }

    case 'file_info': {
      const path = typeof args['path'] === 'string' ? args['path'] : '';
      if (!path) return 'Error: file_info requires "path"';
      try {
        const info = await stat(resolveToolPath(path, ctx));
        return JSON.stringify({
          ok: true,
          path,
          type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'other',
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
          createdAt: info.birthtime.toISOString(),
        });
      } catch (error) {
        return JSON.stringify({ ok: false, path, error: String(error) });
      }
    }

    case 'edit_file': {
      const path = typeof args['path'] === 'string' ? args['path'] : undefined;
      const editsArg = args['edits'];
      if (!path) return 'Error: edit_file requires "path"';
      if (editsArg === undefined || editsArg === null || editsArg === '') return 'Error: edit_file requires "edits"';
      const globalExpected = typeof args['expectedReplacements'] === 'number' ? args['expectedReplacements'] : undefined;
      const globalReplaceAll = args['replaceAll'] === true;
      const targetPath = resolveWriteTarget(path, ctx);
      const readDecision = authorizeToolCall(policy, 'read_file', { path: targetPath });
      if (!readDecision.ok) return formatPolicyError('edit_file', readDecision);
      const writeDecision = authorizeToolCall(policy, 'edit_file', { path: targetPath });
      if (!writeDecision.ok) return formatPolicyError('edit_file', writeDecision);

      return withWriteLock(ctx, targetPath, async () => {
        let src: string;
        try {
          src = await readFile(targetPath, 'utf8');
        } catch (error) {
          return `Error reading file for edit: ${String(error)}`;
        }
        const currentVersion = contentVersion(src);
        if (ctx?.requirePriorRead) {
          const readVersion = ctx.getReadVersion?.(targetPath);
          if (!readVersion) {
            return `Error: edit_file requires a prior read_file of ${path} in this session. Read the file, then retry the edit.`;
          }
          if (readVersion !== currentVersion) {
            return `Error: edit_file read lease is stale for ${path}; the file changed after it was read. Read it again before editing.`;
          }
        }

        let parsed: Array<{ search: string; replace?: string; expectedReplacements?: number; replaceAll?: boolean }>;
        try {
          if (Array.isArray(editsArg)) {
            parsed = editsArg as Array<{ search: string; replace?: string; expectedReplacements?: number; replaceAll?: boolean }>;
          } else {
            const raw = String(editsArg).trim();
            const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
            parsed = JSON.parse(fenced?.[1] ?? raw) as Array<{ search: string; replace?: string; expectedReplacements?: number; replaceAll?: boolean }>;
          }
          if (!Array.isArray(parsed)) return 'Error: edits must be a JSON array';
        } catch (error) {
          return `Error parsing edits JSON: ${String(error)}`;
        }

        const noMatchError = (index: number, search: string, haystack = content): string => {
          const hints = closestLineHints(haystack, search);
          const hint = hints.length > 0 ? `\nFirst line of the search loosely appears near lines: ${hints.join(', ')}.` : '';
          const closest = closestMatch(haystack, search);
          const detail = closest
            ? `\nClosest normalized window: lines ${closest.line}-${closest.line + search.split('\n').length - 1} (similarity ${closest.similarity.toFixed(3)}).\n${diagnosticDiff(search, closest.matched)}`
            : '';
          return `Error: edit[${index}]: Could not find old text in ${path}. It must match exactly, including whitespace, indentation, and line endings.\nSearch string was:\n${search}${hint}${detail}\nNext action: resubmit the exact matched text.`;
        };

        let content = src;
        const log: string[] = [];
        const diagnostics: string[] = [];
        const applied: Array<{ search: string; replace: string; made: number }> = [];
        for (let i = 0; i < parsed.length; i += 1) {
          const entry = parsed[i]!;
          const search = entry.search;
          const replace = entry.replace ?? '';
          if (typeof search !== 'string') return `Error: edit[${i}].search must be a string`;
          if (entry.replace !== undefined && typeof entry.replace !== 'string') return `Error: edit[${i}].replace must be a string`;
          const replaceAll = entry.replaceAll === true || globalReplaceAll;
          const expected = typeof entry.expectedReplacements === 'number' ? entry.expectedReplacements : globalExpected;

          if (search === replace) {
            log.push(`edit[${i}]: no-op (search equals replace)`);
            continue;
          }

          const numberedSearch = stripReadFileLineNumbers(search);
          const unescapedSearch = unescapeEscapes(search);
          const variants = [search];
          if (!replaceAll) {
            if (numberedSearch !== undefined && numberedSearch !== search && !variants.includes(numberedSearch)) variants.push(numberedSearch);
            if (unescapedSearch !== search && !variants.includes(unescapedSearch)) variants.push(unescapedSearch);
          }

          if (replaceAll) {
            let usedVariant: string | undefined;
            let count = 0;
            for (const variant of variants) {
              count = countOccurrences(content, variant);
              if (count > 0) {
                usedVariant = variant;
                break;
              }
            }
            if (!usedVariant) return noMatchError(i, search);
            if (expected !== undefined && count !== expected) {
              return `Error: edit[${i}]: expected ${expected} occurrence(s) of old text in ${path} but found ${count}.`;
            }
            const effectiveReplace = usedVariant === unescapedSearch ? unescapeEscapes(replace) : replace;
            content = content.split(usedVariant).join(effectiveReplace);
            applied.push({ search: usedVariant, replace: effectiveReplace, made: count });
            log.push(`edit[${i}]: replaced ${count} occurrence(s)`);
            continue;
          }

          let outcome = findUniqueMatch(content, variants[0]!);
          let matchedVariant = variants[0]!;
          for (const variant of variants.slice(1)) {
            if (outcome.kind !== 'none') break;
            outcome = findUniqueMatch(content, variant);
            if (outcome.kind !== 'none') matchedVariant = variant;
          }

          if (outcome.kind === 'none') {
            return noMatchError(i, search);
          }
          if (outcome.kind === 'ambiguous') {
            const expectedNote = expected !== undefined && expected !== outcome.count ? ` (expectedReplacements was ${expected})` : '';
            return `Error: edit[${i}]: Found ${outcome.count} matches of old text in ${path} at lines ${outcome.lines.join(', ')}. Provide more surrounding context to make the match unique${expectedNote}.`;
          }
          if (expected !== undefined && expected !== 1) {
            return `Error: edit[${i}]: expected ${expected} occurrence(s) of old text in ${path} but found 1. Set replaceAll: true to replace every occurrence.`;
          }

          const matched = outcome.matched;
          const effectiveReplace = matchedVariant === unescapedSearch ? unescapeEscapes(replace) : replace;
          content = content.replace(matched, effectiveReplace);
          applied.push({ search: matched, replace: effectiveReplace, made: 1 });
          const normalizedLineNumbers = numberedSearch !== undefined && matchedVariant === numberedSearch;
          log.push(`edit[${i}]: replaced ${matched.length} chars via ${outcome.strategy}${normalizedLineNumbers ? ' (line-number normalized)' : ''}${outcome.strategy === 'exact' ? '' : ' [non-exact; use exact text next time]'}`);
          if (outcome.strategy !== 'exact' || normalizedLineNumbers) {
            diagnostics.push(`edit[${i}] matched span vs requested (strategy: ${outcome.strategy}${normalizedLineNumbers ? ', line-number normalized' : ''}):\n${diagnosticDiff(search, matched)}`);
          }
        }

        if (content === src) {
          return `OK: no changes made to ${path}${log.length > 0 ? ` (${log.join('; ')})` : ''}`;
        }

        try {
          const writtenPath = await stagedWrite(path, content, ctx, (written) => {
            for (const edit of applied) {
              if (edit.replace === '') {
                if (countOccurrences(written, edit.search) !== 0) {
                  throw new Error(`readback verification failed for ${path}: deleted text is still present after write.`);
                }
              } else if (countOccurrences(written, edit.replace) < edit.made) {
                throw new Error(`readback verification failed for ${path}: expected at least ${edit.made} occurrence(s) of the replaced text in the written file.`);
              }
            }
          });
          await gitAutoCommit(writtenPath, `edit: ${path} (${applied.length} change${applied.length === 1 ? '' : 's'})`, ctx);
          const diff = unifiedDiff(path, src, content);
          const sha256 = createHash('sha256').update(content).digest('hex').slice(0, 12);
          ctx?.recordWriteVersion?.(targetPath, contentVersion(content));
          const linesBefore = src.split('\n').length;
          const linesAfter = content.split('\n').length;
          return [`OK: ${log.join('; ')} (${writtenPath}); ${linesBefore} → ${linesAfter} lines; sha256:${sha256}`, diagnostics.join('\n\n'), diff].filter(Boolean).join('\n\n');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return `Error writing edited file: ${message} (target left unchanged)`;
        }
      });
    }

    case 'repo_map': {
      const root = typeof args['root'] === 'string' ? args['root'] : '.';
      const maxDepth = parseInt(typeof args['max_depth'] === 'string' ? args['max_depth'] : '6', 10);
      try {
        const files = await walkDir(resolveToolPath(root, ctx), Number.isNaN(maxDepth) ? 6 : maxDepth);
        if (files.length === 0) return '(no supported source files found)';
        const lines: string[] = [`Repo map — ${files.length} file(s):\n`];
        for (const { path, symbols } of files) {
          const base = workspaceRoot(ctx);
          const rel = path.startsWith(base) ? path.slice(base.length + 1) : path;
          lines.push(`  ${rel}`);
          if (symbols.length > 0) {
            lines.push(`    ${symbols.join(', ')}`);
          }
        }
        return lines.join('\n');
      } catch (error) {
        return `Error generating repo map: ${String(error)}`;
      }
    }

    case 'write_file': {
      const path = typeof args['path'] === 'string' ? args['path'] : undefined;
      const content = typeof args['content'] === 'string' ? args['content'] : undefined;
      if (!path) return 'Error: write_file requires "path"';
      if (content === undefined) return 'Error: write_file requires "content"';
      const policyError = authorizeWithResolvedPath(policy, 'write_file', path, ctx);
      if (policyError) return policyError;
      const targetPath = resolveWriteTarget(path, ctx);

      return withWriteLock(ctx, targetPath, async () => {
        try {
          let previous = '';
          let existed = false;
          try {
            previous = await readFile(targetPath, 'utf8');
            existed = true;
          } catch {
            previous = '';
          }
          const snapshot = existed ? await snapshotBeforeWrite(targetPath, workspaceRoot(ctx)) : { path: null as string | null };
          const writtenPath = await writeViaWorkspace(path, content, ctx);
          await gitAutoCommit(writtenPath, `write: ${path}`, ctx);
          const diff = unifiedDiff(path, previous, content);
          let note = 'created new file';
          if (existed) {
            const lineCount = previous === '' ? 0 : previous.replace(/\n$/, '').split('\n').length;
            note = snapshot.path
              ? `overwrote existing file (${lineCount} lines); snapshot saved to ${snapshot.path}`
              : `overwrote existing file (${lineCount} lines); snapshot unavailable (${snapshot.reason ?? 'unknown'})`;
          }
          return [`OK: wrote ${writtenPath} (${content.length} chars); ${note}`, diff].filter(Boolean).join('\n\n');
        } catch (error) {
          return `Error writing file: ${String(error)}`;
        }
      });
    }

    case 'list_dir': {
      const dir = typeof args['path'] === 'string' ? args['path'] : '.';
      try {
        const entries = await readdir(resolveToolPath(dir, ctx), { withFileTypes: true });
        return entries
          .map((entry) => (entry.isDirectory() ? `[dir]  ${entry.name}` : `[file] ${entry.name}`))
          .join('\n') || '(empty directory)';
      } catch (error) {
        return `Error listing directory: ${String(error)}`;
      }
    }

    case 'git_log': {
      const path = typeof args['path'] === 'string' ? args['path'] : undefined;
      const maxCount = Math.max(1, Math.min(Number(args['max_count'] ?? 20), 100));
      try {
        const gitArgs = [
          'log', `--max-count=${maxCount}`,
          '--date=short', '--pretty=format:%h%x09%ad%x09%an%x09%s',
          ...(path ? ['--', path] : []),
        ];
        const result = await execFileAsync('git', gitArgs, {
          cwd: workspaceRoot(ctx), timeout: 20_000, maxBuffer: 1024 * 1024 * 2, signal: ctx?.signal,
        });
        return result.stdout.trim() || '(no commits)';
      } catch (error: unknown) {
        const err = error as { stderr?: string; message?: string };
        return err.stderr?.trim() || `Error: ${err.message ?? String(error)}`;
      }
    }

    case 'bash': {
      const command = typeof args['command'] === 'string' ? args['command'] : undefined;
      if (!command) return 'Error: bash requires "command"';
      const cwd = typeof args['cwd'] === 'string'
        ? resolveToolPath(args['cwd'], ctx)
        : ctx?.artifactDir
          ? resolve(ctx.artifactDir)
          : workspaceRoot(ctx);
      const timeout = Math.max(100, Math.min(Number(args['timeout_ms'] ?? 60_000), 300_000));
      const cwdDecision = authorizeToolCall(policy, 'bash', { ...args, cwd });
      if (!cwdDecision.ok) return formatPolicyError('bash', cwdDecision);
      try {
        if (ctx?.artifactDir && typeof args['cwd'] !== 'string') {
          await mkdir(cwd, { recursive: true });
        }
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024 * 4,
          signal: ctx?.signal,
        });
        const output = [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n');
        const win32Note = process.platform === 'win32'
          ? '\n(Note: shell is cmd.exe — grep/ripgrep-like Unix utilities are unavailable; use search_text/read_file instead.)'
          : '';
        return boundedOutput(output || '(no output)') + win32Note;
      } catch (error: unknown) {
        const err = error as { stdout?: string; stderr?: string; message?: string };
        const output = [err.stdout, err.stderr].filter(Boolean).join('\n');
        return `Error: command failed${output ? `\n${output}` : `: ${err.message ?? String(error)}`}`;
      }
    }

    case 'load_skill': {
      const name = typeof args['name'] === 'string' ? args['name'] : undefined;
      if (!name) return 'Error: load_skill requires "name"';
      if (!/^[a-z0-9_-]+$/i.test(name)) return 'Error: invalid skill name';
      const candidates = [resolve(workspaceRoot(ctx), 'skills'), resolve(import.meta.dirname, '..', '..', 'skills')];
      for (const skillsDir of candidates) {
        try { return await readFile(resolve(skillsDir, `${name}.md`), 'utf8'); } catch { /* try next root */ }
      }
      const available = new Set<string>();
      for (const skillsDir of candidates) {
        try { for (const file of await readdir(skillsDir)) if (file.endsWith('.md')) available.add(file.slice(0, -3)); } catch { /* ignore */ }
      }
      return `Error: skill "${name}" not found${available.size ? `. Available: ${[...available].sort().join(', ')}` : ''}`;
    }

    default:
      return `Error: unknown tool "${name}"`;
  }
}

/** Default built-in registry. Consumers can use ToolRegistry directly for custom sets. */
export const toolRegistry = new ToolRegistry<BuiltinToolContext>();
for (const definition of TOOLS) {
  const name = definition.function.name;
  toolRegistry.register({
    definition,
    metadata: TOOL_METADATA[name] ?? { effect: 'read', category: 'agent' },
    execute: (args, context) => executeBuiltinTool(name, args, context),
  });
}

export function listTools(options: { includeHidden?: boolean } = {}) {
  return toolRegistry.describe(options);
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: BuiltinToolContext,
): Promise<string> {
  return toolRegistry.execute(name, args, ctx);
}
