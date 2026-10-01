import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Skills are short Markdown guidelines an agent loads on demand (`load_skill`).
 * Like agent specs they resolve in layers, the nearest one wins:
 *
 *   <workspace>/.coder/skills   project
 *   <workspace>/skills          project (kept for existing setups)
 *   ~/.coder/skills             user
 *   <package>/skills            built in
 *
 * Only a name and a one-line description are advertised up front (progressive
 * disclosure); the body is read when the skill is actually loaded.
 */

const BUILTIN_SKILLS_DIR = resolve(import.meta.dirname, '..', '..', 'skills');
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DESCRIPTION_MAX_CHARS = 160;

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

export interface SkillRootOptions {
  userDir?: string;
  builtinDir?: string;
}

/** Search roots, highest precedence first. */
export function skillRoots(workspaceRoot: string, options: SkillRootOptions = {}): string[] {
  return [
    resolve(workspaceRoot, '.coder', 'skills'),
    resolve(workspaceRoot, 'skills'),
    resolve(options.userDir ?? join(homedir(), '.coder', 'skills')),
    resolve(options.builtinDir ?? BUILTIN_SKILLS_DIR),
  ];
}

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME.test(name);
}

function stripFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (pair) meta[pair[1]!.toLowerCase()] = pair[2]!.trim().replace(/^['"]|['"]$/g, '');
  }
  return { meta, body: text.slice(match[0].length) };
}

/** `description:` from frontmatter, else the first prose line (skipping headings). */
export function describeSkill(text: string): string {
  const { meta, body } = stripFrontmatter(text);
  const line = meta['description']
    ?? body.split(/\r?\n/).map((candidate) => candidate.trim()).find((candidate) => candidate && !candidate.startsWith('#'))
    ?? '';
  const flat = line.replace(/^Use this skill (when|for|to)\s+/i, (_, word: string) => `${word[0]!.toUpperCase()}${word.slice(1)} `).replace(/\s+/g, ' ').trim();
  return flat.length > DESCRIPTION_MAX_CHARS ? `${flat.slice(0, DESCRIPTION_MAX_CHARS - 1)}…` : flat;
}

async function skillFiles(root: string): Promise<string[]> {
  try {
    return (await readdir(root)).filter((file) => file.endsWith('.md') && isValidSkillName(file.slice(0, -3))).sort();
  } catch {
    return [];
  }
}

/** Every skill visible from these roots; a name found in an earlier root hides later ones. */
export async function listSkills(roots: string[]): Promise<SkillSummary[]> {
  const seen = new Map<string, SkillSummary>();
  for (const root of roots) {
    for (const file of await skillFiles(root)) {
      const name = file.slice(0, -3);
      if (seen.has(name)) continue;
      const path = join(root, file);
      try {
        seen.set(name, { name, description: describeSkill(await readFile(path, 'utf8')), path });
      } catch { /* unreadable skill files are skipped */ }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkill(name: string, roots: string[]): Promise<string | undefined> {
  if (!isValidSkillName(name)) return undefined;
  for (const root of roots) {
    try { return await readFile(join(root, `${name}.md`), 'utf8'); } catch { /* try the next root */ }
  }
  return undefined;
}

/** Text appended to the load_skill tool description; empty when there are no skills. */
export function formatSkillCatalog(skills: SkillSummary[]): string {
  if (!skills.length) return '';
  return `\nAvailable skills:\n${skills.map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description}` : ''}`).join('\n')}\nLoad one when the task matches it; its full text is only read when you call this tool.`;
}
