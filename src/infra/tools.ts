import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ToolContext } from '../domain/task.js';
import {
  authorizeToolCall,
  clonePolicy,
  defaultPolicy,
  formatPolicyError,
  type ToolPolicy,
} from '../policy.js';

const execAsync = promisify(exec);
const AGENT_WORKSPACE_ROOT = resolve(process.cwd(), '.agent-workspace');

async function gitAutoCommit(filePath: string, message: string): Promise<void> {
  if (process.env.AGENT_AUTO_COMMIT !== '1') return;
  try {
    await execAsync(`git add "${filePath}" && git commit -m "${message.replace(/"/g, "'")}" --no-verify`, {
      timeout: 15_000,
      cwd: process.cwd(),
    });
  } catch {
    // Best-effort only.
  }
}

async function writeViaWorkspace(targetPath: string, content: string): Promise<void> {
  const absoluteTarget = isAbsolute(targetPath) ? targetPath : resolve(process.cwd(), targetPath);
  const rel = relative(process.cwd(), absoluteTarget);
  const workspacePath = join(AGENT_WORKSPACE_ROOT, rel);
  await mkdir(dirname(workspacePath), { recursive: true });
  await writeFile(workspacePath, content, 'utf8');
  await mkdir(dirname(absoluteTarget), { recursive: true });
  await writeFile(absoluteTarget, content, 'utf8');
}

function unifiedDiff(filePath: string, before: string, after: string, maxChangedLines = 160): string {
  if (before === after) return '';
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start += 1;
  }

  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;
  while (beforeEnd >= start && afterEnd >= start && beforeLines[beforeEnd] === afterLines[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const contextBeforeStart = Math.max(0, start - 3);
  const contextAfterEnd = Math.min(afterLines.length - 1, afterEnd + 3);
  const lines = [
    '```diff',
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -${contextBeforeStart + 1} +${contextBeforeStart + 1} @@`,
  ];

  for (const line of beforeLines.slice(contextBeforeStart, start)) {
    lines.push(` ${line}`);
  }

  const removed = beforeLines.slice(start, beforeEnd + 1);
  const added = afterLines.slice(start, afterEnd + 1);
  const changed = [
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  if (changed.length > maxChangedLines) {
    lines.push(...changed.slice(0, maxChangedLines));
    lines.push(` ... ${changed.length - maxChangedLines} more changed lines`);
  } else {
    lines.push(...changed);
  }

  for (const line of afterLines.slice(afterEnd + 1, contextAfterEnd + 1)) {
    lines.push(` ${line}`);
  }

  lines.push('```');
  return lines.join('\n');
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

let defaultToolPolicy: ToolPolicy = defaultPolicy();

export function setToolPolicy(policy: ToolPolicy): void {
  defaultToolPolicy = clonePolicy(policy);
}

export function getToolPolicy(): ToolPolicy {
  return clonePolicy(defaultToolPolicy);
}

async function withWriteLock<T>(
  ctx: ToolContext | undefined,
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

export interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, {
        type: string;
        description: string;
        items?: Record<string, unknown>;
        enum?: string[];
      }>;
      required: string[];
    };
  };
}

export const TOOLS: OllamaToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full content of a file from disk. Always call this before writing to an existing file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' },
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
      name: 'bash',
      description: 'Execute a shell command and return stdout + stderr. Use for builds, tests, git, installs, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
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

export async function executeTool(
  name: string,
  args: Record<string, string>,
  ctx?: ToolContext,
): Promise<string> {
  const policy = ctx?.policy ?? getToolPolicy();
  const decision = authorizeToolCall(policy, name, args);
  if (!decision.ok) return formatPolicyError(name, decision);

  switch (name) {
    case 'read_file': {
      const path = args['path'];
      if (!path) return 'Error: read_file requires "path"';
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        return `Error reading file: ${String(error)}`;
      }
    }

    case 'edit_file': {
      const path = args['path'];
      const edits = args['edits'];
      if (!path) return 'Error: edit_file requires "path"';
      if (!edits) return 'Error: edit_file requires "edits"';

      return withWriteLock(ctx, path, async () => {
        let src: string;
        try {
          src = await readFile(path, 'utf8');
        } catch (error) {
          return `Error reading file for edit: ${String(error)}`;
        }

        let parsed: Array<{ search: string; replace: string }>;
        try {
          const raw = edits.trim();
          const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
          parsed = JSON.parse(fenced?.[1] ?? raw) as Array<{ search: string; replace: string }>;
          if (!Array.isArray(parsed)) return 'Error: edits must be a JSON array';
        } catch (error) {
          return `Error parsing edits JSON: ${String(error)}`;
        }

        let content = src;
        const log: string[] = [];
        for (let i = 0; i < parsed.length; i += 1) {
          const { search, replace } = parsed[i]!;
          if (typeof search !== 'string') return `Error: edit[${i}].search must be a string`;
          if (!content.includes(search)) {
            return `Error: edit[${i}] search string not found in file. Make sure it matches exactly (whitespace and indentation included).\nSearch string was:\n${search}`;
          }
          content = content.replace(search, replace ?? '');
          log.push(`edit[${i}]: replaced ${search.length} chars`);
        }

        try {
          await writeViaWorkspace(path, content);
          await gitAutoCommit(path, `edit: ${path} (${parsed.length} change${parsed.length === 1 ? '' : 's'})`);
          const diff = unifiedDiff(path, src, content);
          return [`OK: ${log.join('; ')}`, diff].filter(Boolean).join('\n\n');
        } catch (error) {
          return `Error writing edited file: ${String(error)}`;
        }
      });
    }

    case 'repo_map': {
      const root = args['root'] ?? '.';
      const maxDepth = parseInt(args['max_depth'] ?? '6', 10);
      try {
        const files = await walkDir(root, Number.isNaN(maxDepth) ? 6 : maxDepth);
        if (files.length === 0) return '(no supported source files found)';
        const lines: string[] = [`Repo map — ${files.length} file(s):\n`];
        for (const { path, symbols } of files) {
          const rel = path.startsWith(process.cwd()) ? path.slice(process.cwd().length + 1) : path;
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
      const path = args['path'];
      const content = args['content'];
      if (!path) return 'Error: write_file requires "path"';
      if (content === undefined) return 'Error: write_file requires "content"';

      return withWriteLock(ctx, path, async () => {
        try {
          let previous = '';
          try {
            previous = await readFile(path, 'utf8');
          } catch {
            previous = '';
          }
          await writeViaWorkspace(path, content);
          await gitAutoCommit(path, `write: ${path}`);
          const diff = unifiedDiff(path, previous, content);
          return [`OK: wrote ${path} (${content.length} chars)`, diff].filter(Boolean).join('\n\n');
        } catch (error) {
          return `Error writing file: ${String(error)}`;
        }
      });
    }

    case 'list_dir': {
      const dir = args['path'] ?? '.';
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries
          .map((entry) => (entry.isDirectory() ? `[dir]  ${entry.name}` : `[file] ${entry.name}`))
          .join('\n') || '(empty directory)';
      } catch (error) {
        return `Error listing directory: ${String(error)}`;
      }
    }

    case 'bash': {
      const command = args['command'];
      if (!command) return 'Error: bash requires "command"';
      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 60_000,
          maxBuffer: 1024 * 1024 * 4,
        });
        const output = [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n');
        return output || '(no output)';
      } catch (error: unknown) {
        const err = error as { stdout?: string; stderr?: string; message?: string };
        const output = [err.stdout, err.stderr].filter(Boolean).join('\n');
        return output || `Error: ${err.message ?? String(error)}`;
      }
    }

    case 'load_skill': {
      const name = args['name'];
      if (!name) return 'Error: load_skill requires "name"';
      const skillsDir = `${import.meta.dirname}/../skills`.replace(/\\/g, '/');
      try {
        return await readFile(`${skillsDir}/${name}.md`, 'utf8');
      } catch {
        try {
          const available = (await readdir(skillsDir)).map((file) => file.replace(/\.md$/, '')).join(', ');
          return `Error: skill "${name}" not found. Available: ${available}`;
        } catch {
          return `Error: skill "${name}" not found`;
        }
      }
    }

    case 'spawn_subagent': {
      if (!ctx?.spawnSubagent) return 'Error: subagent support unavailable';
      return ctx.spawnSubagent(args['prompt']);
    }

    case 'collect_subagent': {
      if (!ctx?.collectSubagent) return 'Error: subagent support unavailable';
      return ctx.collectSubagent(args['subagent_id']);
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
          const parsed = JSON.parse(rawChoices) as unknown;
          if (Array.isArray(parsed)) {
            choices = parsed.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
          }
        } catch {
          // Ignore malformed choices and fall back to master-generated options.
        }
      }
      return ctx.requestClarification(args['question'] ?? '', choices);
    }

    default:
      return `Error: unknown tool "${name}"`;
  }
}
