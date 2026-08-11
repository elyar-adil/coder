import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolDefinition, ToolExecutionContext, ToolMetadata } from '../tools/types.js';
import { unifiedDiff } from '../diff.js';
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
  await writeFile(workspacePath, content, 'utf8');
  await mkdir(dirname(absoluteTarget), { recursive: true });
  await writeFile(absoluteTarget, content, 'utf8');
  return absoluteTarget;
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

// ── Fuzzy edit matching (inspired by OpenCode's multi-strategy approach) ──────
//
// LLMs frequently produce search strings with minor whitespace or indentation
// drift. Rather than hard-failing, we attempt progressively looser strategies
// in order, mirroring the 9-level approach described in the OpenCode analysis.

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
}

function stripReadFileLineNumbers(search: string): string | undefined {
  const lines = search.split('\n');
  const contentLines = lines.filter((line) => !line.startsWith('... (showing lines '));
  if (contentLines.length === 0) return undefined;
  const hasLineNumbers = contentLines.every((line) => /^\d{5}\|/.test(line));
  if (!hasLineNumbers) return undefined;
  return contentLines.map((line) => line.replace(/^\d{5}\|/, '')).join('\n');
}

/** Try to locate `search` in `content` using progressively looser strategies.
 *  Returns the best matching substring of `content` at the same length, or
 *  undefined if no strategy succeeds. */
function fuzzyFind(content: string, search: string): string | undefined {
  // Strategy 1: exact
  if (content.includes(search)) return search;

  // Strategy 2: line-trimmed — trim each line, compare trimmed blocks
  const trimLines = (s: string) => s.split('\n').map((l) => l.trim()).join('\n');
  const searchTrimmed = trimLines(search);
  const contentLines = content.split('\n');
  const searchLineCount = search.split('\n').length;
  for (let i = 0; i <= contentLines.length - searchLineCount; i++) {
    const window = contentLines.slice(i, i + searchLineCount).join('\n');
    if (trimLines(window) === searchTrimmed) return window;
  }

  // Strategy 3: whitespace-normalized — collapse all whitespace runs
  const normWS = (s: string) => s.replace(/[\t ]+/g, ' ').trim();
  const searchNorm = normWS(search);
  for (let i = 0; i <= contentLines.length - searchLineCount; i++) {
    const window = contentLines.slice(i, i + searchLineCount).join('\n');
    if (normWS(window) === searchNorm) return window;
  }

  // Strategy 4: indentation-flexible — strip common leading indent from search
  const stripIndent = (s: string) => {
    const lines = s.split('\n');
    const minIndent = lines
      .filter((l) => l.trim())
      .reduce((min, l) => Math.min(min, l.match(/^\s*/)?.[0].length ?? 0), Infinity);
    return lines.map((l) => l.slice(minIndent === Infinity ? 0 : minIndent)).join('\n');
  };
  const searchStripped = stripIndent(search);
  for (let i = 0; i <= contentLines.length - searchLineCount; i++) {
    const window = contentLines.slice(i, i + searchLineCount).join('\n');
    if (stripIndent(window) === searchStripped) return window;
  }

  // Strategy 5: escape-normalized — resolve common escape sequences
  const normEscape = (s: string) =>
    s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const searchEsc = normEscape(search);
  for (let i = 0; i <= contentLines.length - searchLineCount; i++) {
    const window = contentLines.slice(i, i + searchLineCount).join('\n');
    if (normEscape(window) === searchEsc) return window;
  }

  // Strategy 6: trim boundaries — trim leading/trailing whitespace of the whole block
  const searchTrimBound = search.trim();
  for (let i = 0; i <= contentLines.length - searchLineCount; i++) {
    const window = contentLines.slice(i, i + searchLineCount).join('\n');
    if (window.trim() === searchTrimBound) return window;
  }

  // Strategy 7: block-anchor with similarity — anchor on first+last line,
  // accept the window if its Levenshtein similarity to search is >= 0.7.
  const searchFirstLine = search.split('\n')[0]?.trim() ?? '';
  const searchLastLine = search.split('\n').at(-1)?.trim() ?? '';
  const candidates: string[] = [];
  for (let i = 0; i <= contentLines.length - searchLineCount; i++) {
    const window = contentLines.slice(i, i + searchLineCount).join('\n');
    const firstMatch = contentLines[i]?.trim() === searchFirstLine;
    const lastMatch = contentLines[i + searchLineCount - 1]?.trim() === searchLastLine;
    if (firstMatch && lastMatch) candidates.push(window);
  }
  const ANCHOR_THRESHOLD = candidates.length === 1 ? 0 : 0.3;
  for (const c of candidates) {
    if (similarity(c, search) >= ANCHOR_THRESHOLD) return c;
  }

  // Strategy 8: context-aware — looser block anchor, 50% similarity threshold
  for (let i = 0; i <= contentLines.length - searchLineCount; i++) {
    const window = contentLines.slice(i, i + searchLineCount).join('\n');
    if (contentLines[i]?.trim() === searchFirstLine && similarity(window, search) >= 0.5) {
      return window;
    }
  }

  return undefined;
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
Each edit finds an EXACT string match and replaces it. Use this instead of write_file
when modifying an existing file — it is safer and preserves surrounding context.

Format: provide a JSON array of {search, replace} pairs.
- "search" must be an exact substring of the current file content (including indentation/newlines).
- "replace" is the new content that replaces it.
- Edits are applied in order; each operates on the result of the previous.
- To delete a block, set "replace" to "".`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to edit' },
          edits: { type: 'string', description: 'JSON array of {search, replace} objects' },
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
      description: 'Execute a shell command and return stdout + stderr. Use for builds, tests, git, installs, etc.',
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
  {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description: 'Delegate a well-defined sub-task to a sub-agent that runs independently. Returns a subagent_id.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Clear, self-contained instructions for the sub-agent.' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'collect_subagent',
      description: 'Retrieve the result of a previously spawned sub-agent by subagent_id.',
      parameters: {
        type: 'object',
        properties: {
          subagent_id: { type: 'string', description: 'The subagent_id returned by spawn_subagent' },
        },
        required: ['subagent_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_patch',
      description: 'Submit a structured patch to the writer agent. Workers should use this instead of directly writing files when patch-writer mode is enabled.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Concise summary of the change.' },
          files: {
            type: 'string',
            description: 'JSON array of {path, baseHash?, before?, after, diff?}. The writer validates baseHash before applying.',
          },
          verificationCommands: {
            type: 'string',
            description: 'JSON array of commands the writer should run after applying the patch.',
          },
        },
        required: ['summary', 'files'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_clarification',
      description: 'Ask the master coordinator for missing information when the task is blocked. The master may answer directly or ask the user.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'A precise clarification question describing what is missing.' },
          choices: {
            type: 'array',
            description: 'Two to four concrete answer options for the user. Avoid generic yes/no labels unless the decision is truly binary.',
            items: { type: 'string' },
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Deprecated alias for request_clarification. Prefer request_clarification.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The clarification question.' },
          choices: {
            type: 'array',
            description: 'Two to four concrete answer options for the user.',
            items: { type: 'string' },
          },
        },
        required: ['question'],
      },
    },
  },
];

export const WORKER_TOOLS = TOOLS.filter((tool) => tool.function.name !== 'ask_user');

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
  git_status: { effect: 'read', category: 'git' },
  git_diff: { effect: 'read', category: 'git' },
  git_log: { effect: 'read', category: 'git' },
  bash: { effect: 'execute', category: 'shell' },
  load_skill: { effect: 'read', category: 'agent' },
  spawn_subagent: { effect: 'coordinate', category: 'agent' },
  collect_subagent: { effect: 'coordinate', category: 'agent' },
  submit_patch: { effect: 'write', category: 'agent' },
  request_clarification: { effect: 'coordinate', category: 'agent' },
  ask_user: { effect: 'coordinate', category: 'agent', hidden: true },
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

async function readLineRange(filePath: string, offset = 1, limit?: number): Promise<string> {
  const raw = await readFile(filePath, 'utf8');
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

function boundedOutput(value: string, maxChars = 4 * 1024 * 1024): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n... (output truncated at ${maxChars} characters)`;
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
        return JSON.stringify({ ok: false, error: String(error?.message ?? error) });
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
        return JSON.stringify({ ok: false, error: String(error?.message ?? error) });
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
        return await readLineRange(resolveToolPath(path, ctx), offsetArg, limitArg);
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
          sections.push(`===== ${path} =====\n${await readLineRange(resolveToolPath(path, ctx), 1, maxLines)}`);
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

        let parsed: Array<{ search: string; replace: string }>;
        try {
          if (Array.isArray(editsArg)) {
            parsed = editsArg as Array<{ search: string; replace: string }>;
          } else {
            const raw = String(editsArg).trim();
            const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
            parsed = JSON.parse(fenced?.[1] ?? raw) as Array<{ search: string; replace: string }>;
          }
          if (!Array.isArray(parsed)) return 'Error: edits must be a JSON array';
        } catch (error) {
          return `Error parsing edits JSON: ${String(error)}`;
        }

        let content = src;
        const log: string[] = [];
        for (let i = 0; i < parsed.length; i += 1) {
          const { search, replace } = parsed[i]!;
          if (typeof search !== 'string') return `Error: edit[${i}].search must be a string`;
          if (replace !== undefined && typeof replace !== 'string') return `Error: edit[${i}].replace must be a string`;
          const numberedSearch = stripReadFileLineNumbers(search);
          const searchVariants = numberedSearch && numberedSearch !== search ? [search, numberedSearch] : [search];
          let matched: string | undefined;
          let normalizedLineNumbers = false;
          for (const candidate of searchVariants) {
            matched = fuzzyFind(content, candidate);
            if (matched !== undefined) {
              normalizedLineNumbers = candidate !== search;
              break;
            }
          }
          if (matched === undefined) {
            return `Error: edit[${i}] search string not found in file (tried 8 fuzzy strategies plus read_file line-number normalization). Make sure the block exists in the file.\nSearch string was:\n${search}`;
          }
          const usedFuzzy = matched !== (normalizedLineNumbers ? numberedSearch : search);
          content = content.replace(matched, replace ?? '');
          log.push(`edit[${i}]: replaced ${matched.length} chars${usedFuzzy || normalizedLineNumbers ? ` (${[normalizedLineNumbers ? 'line-number normalized' : '', usedFuzzy ? 'fuzzy match' : ''].filter(Boolean).join(', ')})` : ''}`);
        }

        try {
          const writtenPath = await writeViaWorkspace(path, content, ctx);
          await gitAutoCommit(writtenPath, `edit: ${path} (${parsed.length} change${parsed.length === 1 ? '' : 's'})`, ctx);
          const diff = unifiedDiff(path, src, content);
          return [`OK: ${log.join('; ')} (${writtenPath})`, diff].filter(Boolean).join('\n\n');
        } catch (error) {
          return `Error writing edited file: ${String(error)}`;
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
          try {
            previous = await readFile(targetPath, 'utf8');
          } catch {
            previous = '';
          }
          const writtenPath = await writeViaWorkspace(path, content, ctx);
          await gitAutoCommit(writtenPath, `write: ${path}`, ctx);
          const diff = unifiedDiff(path, previous, content);
          return [`OK: wrote ${writtenPath} (${content.length} chars)`, diff].filter(Boolean).join('\n\n');
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
        return boundedOutput(output || '(no output)');
      } catch (error: unknown) {
        const err = error as { stdout?: string; stderr?: string; message?: string };
        const output = [err.stdout, err.stderr].filter(Boolean).join('\n');
        return output || `Error: ${err.message ?? String(error)}`;
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

    case 'spawn_subagent': {
      if (!ctx?.spawnSubagent) return 'Error: subagent support unavailable';
      return ctx.spawnSubagent(typeof args['prompt'] === 'string' ? args['prompt'] : '');
    }

    case 'collect_subagent': {
      if (!ctx?.collectSubagent) return 'Error: subagent support unavailable';
      return ctx.collectSubagent(typeof args['subagent_id'] === 'string' ? args['subagent_id'] : '');
    }

    case 'submit_patch': {
      if (!ctx?.submitPatch) return 'Error: patch writer support unavailable';
      const summary = typeof args['summary'] === 'string' ? args['summary'] : '';
      let files: Array<{ path: string; baseHash?: string; before?: string; after: string; diff?: string }>;
      let verificationCommands: string[] = [];
      try {
        const rawValue = args['files'];
        if (Array.isArray(rawValue)) {
          files = rawValue as Array<{ path: string; baseHash?: string; before?: string; after: string; diff?: string }>;
        } else {
          const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
          const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
          files = JSON.parse(fenced?.[1] ?? raw) as Array<{ path: string; baseHash?: string; before?: string; after: string; diff?: string }>;
        }
        if (!Array.isArray(files)) return 'Error: submit_patch files must be a JSON array';
      } catch (error) {
        return `Error parsing submit_patch files JSON: ${String(error)}`;
      }
      for (const [index, file] of files.entries()) {
        if (!file || typeof file.path !== 'string' || !file.path.trim()) return `Error: submit_patch files[${index}].path is required`;
        if (typeof file.after !== 'string') return `Error: submit_patch files[${index}].after must be a string`;
      }
      for (const file of files) {
        const pathDecision = authorizeToolCall(policy, 'write_file', { path: resolveToolPath(file.path, ctx) });
        if (!pathDecision.ok) return formatPolicyError('submit_patch', pathDecision);
      }
      if (args['verificationCommands']) {
        try {
          const rawValue = args['verificationCommands'];
          const parsed = Array.isArray(rawValue)
            ? rawValue
            : (() => {
              const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
              const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
              return JSON.parse(fenced?.[1] ?? raw) as unknown;
            })();
          if (Array.isArray(parsed)) {
            verificationCommands = parsed.filter((item): item is string => typeof item === 'string');
          }
        } catch {
          verificationCommands = [];
        }
      }
      return ctx.submitPatch({ summary, files, verificationCommands });
    }

    case 'request_clarification':
    case 'ask_user': {
      if (!ctx?.requestClarification) {
        return 'Error: clarification requests are not available in this context';
      }
      let choices: string[] | undefined;
      const rawChoices = args['choices'];
      if (rawChoices) {
        try {
          const parsed = Array.isArray(rawChoices)
            ? rawChoices
            : JSON.parse(typeof rawChoices === 'string' ? rawChoices : JSON.stringify(rawChoices)) as unknown;
          if (Array.isArray(parsed)) {
            choices = parsed.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
          }
        } catch {
          // Ignore malformed choices and fall back to master-generated options.
        }
      }
      return ctx.requestClarification(typeof args['question'] === 'string' ? args['question'] : '', choices);
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
