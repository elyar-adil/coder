import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';

import type { AgentSpec, AgentSpecScope } from '../domain/agent.js';

export interface AgentRegistryOptions {
  workspaceRoot?: string;
  builtinDir?: string;
  userDir?: string;
  projectDir?: string;
}

type Frontmatter = Record<string, string | string[]>;

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === '[]') return [];
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [unquote(trimmed)].filter(Boolean);
  return trimmed.slice(1, -1).split(',').map((item) => unquote(item)).filter(Boolean);
}

function parseDocument(raw: string, source: string, id: string, scope: AgentSpecScope): AgentSpec {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) throw new Error(`Agent spec ${source} must start with YAML frontmatter`);
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) throw new Error(`Agent spec ${source} has no closing frontmatter delimiter`);
  const header = normalized.slice(4, end);
  const instructions = normalized.slice(end + 5).trim();
  const data: Frontmatter = {};
  let activeList: string | undefined;
  for (const rawLine of header.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '');
    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (listItem && activeList) {
      const values = Array.isArray(data[activeList]) ? data[activeList] as string[] : [];
      values.push(unquote(listItem[1]!));
      data[activeList] = values;
      continue;
    }
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!field) {
      if (line.trim()) throw new Error(`Invalid frontmatter line in ${source}: ${rawLine}`);
      continue;
    }
    const [, key, value] = field;
    if (value) {
      data[key!] = (value.startsWith('[') && value.endsWith(']')) ? parseInlineList(value) : unquote(value);
      activeList = undefined;
    } else {
      data[key!] = [];
      activeList = key;
    }
  }
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!description) throw new Error(`Agent spec ${source} requires a description`);
  if (!instructions) throw new Error(`Agent spec ${source} requires instructions`);
  const tools = Array.isArray(data.tools) ? data.tools : data.tools ? [String(data.tools)] : [];
  const agents = Array.isArray(data.agents) ? data.agents : data.agents ? [String(data.agents)] : [];
  const model = typeof data.model === 'string' && data.model !== 'inherit' ? data.model : undefined;
  return { id, description, model, tools, agents, instructions, source, scope };
}

async function markdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path);
    }
  };
  await visit(root);
  return files.sort();
}

function specId(root: string, file: string): string {
  return relative(root, file).split(sep).join('/').replace(/\.md$/i, '');
}

function matchesSelector(id: string, selector: string): boolean {
  if (selector === '*') return true;
  if (selector.endsWith('/*')) return id.startsWith(selector.slice(0, -1));
  return id === selector;
}

export class AgentRegistry {
  private readonly specs = new Map<string, AgentSpec>();
  private readonly roots: Array<{ path: string; scope: AgentSpecScope }>;

  constructor(options: AgentRegistryOptions = {}) {
    const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    const builtinDir = resolve(options.builtinDir ?? resolve(import.meta.dirname, '..', '..', 'agents'));
    this.roots = [
      { path: builtinDir, scope: 'builtin' },
      { path: resolve(options.userDir ?? resolve(homedir(), '.coder', 'agents')), scope: 'user' },
      { path: resolve(options.projectDir ?? resolve(workspaceRoot, '.coder', 'agents')), scope: 'project' },
    ];
  }

  async load(): Promise<void> {
    this.specs.clear();
    for (const root of this.roots) {
      for (const file of await markdownFiles(root.path)) {
        const id = specId(root.path, file);
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id) || id.includes('..')) {
          throw new Error(`Invalid agent id derived from ${file}`);
        }
        this.specs.set(id, parseDocument(await readFile(file, 'utf8'), file, id, root.scope));
      }
    }
    if (!this.specs.has('main')) throw new Error('No main agent spec found');
  }

  get(id: string): AgentSpec | undefined {
    const spec = this.specs.get(id);
    return spec ? { ...spec, tools: [...spec.tools], agents: [...spec.agents] } : undefined;
  }

  list(): AgentSpec[] {
    return [...this.specs.values()].sort((a, b) => a.id.localeCompare(b.id)).map((spec) => this.get(spec.id)!);
  }

  allowedAgents(specOrId: AgentSpec | string): AgentSpec[] {
    const spec = typeof specOrId === 'string' ? this.specs.get(specOrId) : specOrId;
    if (!spec) return [];
    return this.list().filter((candidate) => (
      candidate.id !== spec.id && spec.agents.some((selector) => matchesSelector(candidate.id, selector))
    ));
  }

  canCall(from: AgentSpec | string, targetId: string): boolean {
    return this.allowedAgents(from).some((candidate) => candidate.id === targetId);
  }
}

export { matchesSelector as matchesAgentSelector, parseDocument as parseAgentSpec };

