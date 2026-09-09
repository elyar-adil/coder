import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  dirty: boolean;
  locked: boolean;
  createdAt?: string;
}

export interface WorktreeCreateOptions {
  /** `fresh` branches from origin/HEAD (fallback: HEAD); `head` from local HEAD. */
  baseRef?: 'fresh' | 'head';
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_INCLUDE_FILES = 50;

/**
 * Managed git worktrees for parallel maw sessions on one repository.
 *
 * Worktrees live under `<main-root>/.coder/worktrees/<name>` on branches named
 * `maw/<name>`. Creation is conservative (a dirty source checkout still
 * branches from HEAD, never from origin), removal refuses to touch dirty
 * checkouts or delete branches, and a worktree is `git worktree lock`ed while
 * a session uses it so concurrent cleanup cannot remove live state.
 */
export class WorktreeManager {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = resolve(cwd);
  }

  private async git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const result = await execFileAsync('git', args, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 * 4 });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
      return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? String(error) };
    }
  }

  private async inGitRepo(cwd = this.cwd): Promise<boolean> {
    const result = await this.git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return result.code === 0 && result.stdout.trim() === 'true';
  }

  /** Main (first) worktree root for the repository containing `cwd`. */
  async mainRoot(): Promise<string> {
    if (!(await this.inGitRepo())) throw new Error('worktree: not inside a git repository');
    const common = await this.git(this.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (common.code === 0) {
      const dir = common.stdout.trim();
      if (dir) {
        const parent = dirname(dir);
        if (basename(dir) === '.git' && parent) return parent;
        return dir;
      }
    }
    const fallback = await this.git(this.cwd, ['worktree', 'list', '--porcelain']);
    if (fallback.code === 0) {
      const first = fallback.stdout.split('\n').find((line) => line.startsWith('worktree '));
      if (first) return first.slice('worktree '.length).trim();
    }
    return this.cwd;
  }

  private async managedDir(): Promise<string> {
    const main = await this.mainRoot();
    return join(main, '.coder', 'worktrees');
  }

  private managedDirSync(mainRoot: string): string {
    return join(mainRoot, '.coder', 'worktrees');
  }

  private branchFor(name: string): string {
    return `maw/${name}`;
  }

  private async metadataPath(name: string, mainRoot?: string): Promise<string> {
    const dir = mainRoot ? this.managedDirSync(mainRoot) : await this.managedDir();
    return join(dir, `${name}.json`);
  }

  private async readMetadata(name: string, mainRoot?: string): Promise<{ name: string; branch: string; createdAt: string } | undefined> {
    try {
      const raw = await readFile(await this.metadataPath(name, mainRoot), 'utf8');
      const parsed = JSON.parse(raw) as { name: string; branch: string; createdAt: string };
      if (parsed && parsed.name === name) return parsed;
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async writeMetadata(mainRoot: string, name: string, branch: string): Promise<void> {
    const path = join(this.managedDirSync(mainRoot), `${name}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ name, branch, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  }

  /** Keep the managed worktree dir out of the user's git status. */
  private async excludeManagedDir(mainRoot: string): Promise<void> {
    const result = await this.git(mainRoot, ['rev-parse', '--git-path', 'info/exclude']);
    if (result.code !== 0) return;
    const relative = result.stdout.trim();
    if (!relative) return;
    const excludePath = resolve(mainRoot, relative);
    let current = '';
    try {
      current = await readFile(excludePath, 'utf8');
    } catch {
      current = '';
    }
    const line = '.coder/worktrees/';
    if (current.split('\n').map((entry) => entry.trim()).includes(line)) return;
    const next = `${current.trimEnd()}${current.trim() ? '\n' : ''}${line}\n`;
    try {
      await mkdir(dirname(excludePath), { recursive: true });
      await writeFile(excludePath, next, 'utf8');
    } catch {
      // Best effort; an untracked .coder dir is acceptable.
    }
  }

  async isGitRepository(): Promise<boolean> {
    return this.inGitRepo();
  }

  /** Create (or reopen) a managed worktree and lock it for the caller. */
  async create(name: string, options: WorktreeCreateOptions = {}): Promise<WorktreeInfo> {
    const trimmed = name.trim();
    if (!NAME_PATTERN.test(trimmed)) {
      throw new Error('worktree: name must be letters, digits, dot, underscore, or dash (max 64 chars)');
    }
    const main = await this.mainRoot();
    const dir = this.managedDirSync(main);
    const path = join(dir, trimmed);
    const branch = this.branchFor(trimmed);
    await this.excludeManagedDir(main);

    let created = false;
    if (!await this.existsDir(path)) {
      await mkdir(dir, { recursive: true });
      const head = await this.git(main, ['rev-parse', 'HEAD']);
      if (head.code !== 0) throw new Error(`worktree: cannot resolve HEAD (${head.stderr.trim()})`);
      let base = head.stdout.trim();
      if ((options.baseRef ?? 'fresh') === 'fresh') {
        const originHead = await this.git(main, ['rev-parse', '--verify', 'origin/HEAD']);
        if (originHead.code === 0) base = originHead.stdout.trim();
      }
      const branchExists = (await this.git(main, ['rev-parse', '--verify', branch])).code === 0;
      const args = branchExists
        ? ['worktree', 'add', path, branch]
        : ['worktree', 'add', '-b', branch, path, base];
      const add = await this.git(main, args);
      if (add.code !== 0) {
        const stderr = add.stderr.trim();
        if (/already exists|already.*checked out|already used/i.test(stderr)) {
          throw new Error(`worktree: ${trimmed} is already in use (${stderr.split('\n')[0]})`);
        }
        throw new Error(`worktree: git worktree add failed: ${stderr.split('\n')[0]}`);
      }
      created = true;
    }

    await this.writeMetadata(main, trimmed, branch);
    await this.git(main, ['worktree', 'lock', '--reason', `maw session in ${trimmed}`, path]);
    if (created) await this.copyIncludedFiles(main, path);
    return { name: trimmed, path, branch, dirty: await this.dirty(path), locked: true, createdAt: (await this.readMetadata(trimmed, main))?.createdAt };
  }

  private async existsDir(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Copy gitignored files matching `.worktreeinclude` from the main checkout. */
  private async copyIncludedFiles(mainRoot: string, worktreePath: string): Promise<void> {
    let patterns: string[] = [];
    try {
      const raw = await readFile(join(mainRoot, '.worktreeinclude'), 'utf8');
      patterns = raw.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    } catch {
      return;
    }
    if (!patterns.length) return;
    const copied = new Set<string>();
    for (const pattern of patterns) {
      const result = await this.git(mainRoot, [
        'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', pattern,
      ]);
      if (result.code !== 0) continue;
      for (const file of result.stdout.split('\0').filter(Boolean)) {
        if (copied.size >= MAX_INCLUDE_FILES) return;
        if (copied.has(file)) continue;
        copied.add(file);
        const source = join(mainRoot, file);
        const target = join(worktreePath, file);
        try {
          await mkdir(dirname(target), { recursive: true });
          await copyFile(source, target);
        } catch {
          continue;
        }
      }
    }
  }

  async dirty(worktreePath: string): Promise<boolean> {
    const result = await this.git(worktreePath, ['status', '--porcelain', '--untracked-files=normal']);
    return result.code === 0 && result.stdout.trim().length > 0;
  }

  private async lockedPaths(): Promise<Set<string>> {
    const main = await this.mainRoot();
    const result = await this.git(main, ['worktree', 'list', '--porcelain']);
    const locked = new Set<string>();
    if (result.code !== 0) return locked;
    let currentPath: string | undefined;
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('worktree ')) currentPath = line.slice('worktree '.length).trim();
      else if (line.startsWith('locked') && currentPath) locked.add(resolve(currentPath));
      else if (line === '') currentPath = undefined;
    }
    return locked;
  }

  /** All managed worktrees with fresh status. */
  async list(): Promise<WorktreeInfo[]> {
    let dir: string;
    try {
      dir = await this.managedDir();
    } catch {
      return [];
    }
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -'.json'.length));
    } catch {
      return [];
    }
    const locked = await this.lockedPaths();
    const list: WorktreeInfo[] = [];
    for (const name of names) {
      const meta = await this.readMetadata(name);
      const path = join(dir, name);
      if (!await this.existsDir(path)) continue;
      list.push({
        name,
        path,
        branch: meta?.branch ?? this.branchFor(name),
        dirty: await this.dirty(path),
        locked: locked.has(resolve(path)),
        createdAt: meta?.createdAt,
      });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Identify the managed worktree containing `path`, if any. */
  async containing(path: string): Promise<WorktreeInfo | undefined> {
    const resolved = resolve(path);
    const all = await this.list();
    return all.find((info) => resolved === info.path || resolved.startsWith(info.path + '/'));
  }

  async unlock(name: string): Promise<void> {
    const info = await this.findExisting(name);
    await this.git((await this.mainRoot()), ['worktree', 'unlock', info.path]);
  }

  private async findExisting(name: string): Promise<WorktreeInfo> {
    const all = await this.list();
    const info = all.find((item) => item.name === name);
    if (!info) throw new Error(`worktree: no managed worktree named ${name}`);
    return info;
  }

  /** Remove a worktree. Refuses when it holds changes; never deletes the branch. */
  async remove(name: string, options: { force?: boolean } = {}): Promise<void> {
    const info = await this.findExisting(name);
    if (info.dirty && !options.force) {
      throw new Error(`worktree: ${name} holds uncommitted changes; resolve or use force`);
    }
    const main = await this.mainRoot();
    if (info.locked) await this.git(main, ['worktree', 'unlock', info.path]);
    const result = await this.git(main, ['worktree', 'remove', '--force', info.path]);
    if (result.code !== 0 && !/is not a working tree|does not exist/i.test(result.stderr)) {
      throw new Error(`worktree: remove failed: ${result.stderr.trim().split('\n')[0]}`);
    }
    await rm(await this.metadataPath(name, main), { force: true }).catch(() => undefined);
  }

  /**
   * Startup/exit sweep: drop managed worktrees that are clean and unlocked.
   * Dirty or locked worktrees (live sessions) are never touched.
   */
  async sweep(): Promise<string[]> {
    const removed: string[] = [];
    let all: WorktreeInfo[] = [];
    try {
      all = await this.list();
    } catch {
      return removed;
    }
    for (const info of all) {
      if (info.dirty || info.locked) continue;
      try {
        await this.remove(info.name);
        removed.push(info.name);
      } catch {
        continue;
      }
    }
    return removed;
  }
}
