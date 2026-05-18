import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import type { ToolContext } from './types.js';
import { authorizeToolCall, defaultPolicy, formatPolicyError, type ToolPolicy } from './policy.js';

const execAsync = promisify(exec);

let activePolicy: ToolPolicy = defaultPolicy();

export function setToolPolicy(policy: ToolPolicy): void {
  activePolicy = policy;
}


export interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
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
      name: 'write_file',
      description: 'Create or overwrite a file with complete content. Always provide the full file — never a partial diff.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Absolute or relative path to the file' },
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
          name: { type: 'string', description: 'Skill name: python-flask, react-component, testing, node-express, git-workflow, debugging, sql-database' },
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
      name: 'ask_user',
      description: 'Ask the user a question when you need clarification. Pauses execution until the user responds.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask the user. Be specific and provide options if possible.' },
        },
        required: ['question'],
      },
    },
  },
];

export async function executeTool(
  name: string,
  args: Record<string, string>,
  ctx?: ToolContext,
): Promise<string> {
  const decision = authorizeToolCall(activePolicy, name, args);
  if (!decision.ok) return formatPolicyError(name, decision);

  switch (name) {
    case 'read_file': {
      const path = args['path'];
      if (!path) return 'Error: read_file requires "path"';
      try {
        return await readFile(path, 'utf8');
      } catch (e) {
        return `Error reading file: ${String(e)}`;
      }
    }

    case 'write_file': {
      const path    = args['path'];
      const content = args['content'];
      if (!path)                 return 'Error: write_file requires "path"';
      if (content === undefined) return 'Error: write_file requires "content"';
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, 'utf8');
        return `OK: wrote ${path} (${content.length} chars)`;
      } catch (e) {
        return `Error writing file: ${String(e)}`;
      }
    }

    case 'list_dir': {
      const dir = args['path'] ?? '.';
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const lines = entries.map((e) =>
          e.isDirectory() ? `[dir]  ${e.name}` : `[file] ${e.name}`,
        );
        return lines.join('\n') || '(empty directory)';
      } catch (e) {
        return `Error listing directory: ${String(e)}`;
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
        const out = [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n');
        return out || '(no output)';
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        const out = [err.stdout, err.stderr].filter(Boolean).join('\n');
        return out || `Error: ${err.message ?? String(e)}`;
      }
    }

    case 'load_skill': {
      const name = args['name'];
      if (!name) return 'Error: load_skill requires "name"';
      const Dir = `${import.meta.dirname}/../skills`.replace(/\\/g, '/');
      try {
        return await readFile(`${Dir}/${name}.md`, 'utf8');
      } catch {
        try {
          const available = (await readdir(Dir)).map((f) => f.replace(/\.md$/, '')).join(', ');
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

    case 'ask_user': {
      if (!ctx?.askUser) return 'Error: ask_user is not available in this context';
      return ctx.askUser(args['question'] ?? '');
    }

    default:
      return `Error: unknown tool "${name}"`;
  }
}
