/**
 * tools.ts — Tool definitions and execution for the coding agent.
 *
 * Exported so they can be unit-tested independently of MasterCoordinator.
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';

const execAsync = promisify(exec);

// ── Ollama tool schema ────────────────────────────────────────────────────────
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
      description:
        'Read the full content of a file from disk. Always call this before writing to an existing file.',
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
      description:
        'Create or overwrite a file with complete content. Always provide the full file — never a partial diff.',
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
      description:
        'Execute a shell command and return stdout + stderr. Use for builds, tests, git, installs, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
];

// ── Tool execution ────────────────────────────────────────────────────────────
export async function executeTool(
  name: string,
  args: Record<string, string>,
): Promise<string> {
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

    default:
      return `Error: unknown tool "${name}"`;
  }
}
