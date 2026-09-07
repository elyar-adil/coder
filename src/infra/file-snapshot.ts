import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export interface WriteSnapshot {
  path: string | null;
  reason?: string;
}

function sanitizeComponent(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
}

function externalKey(abs: string): string {
  return sanitizeComponent(abs.replace(/^([a-zA-Z]:)?[/\\]+/, ''));
}

function snapshotDirFor(abs: string, workspaceRoot?: string): string {
  if (workspaceRoot) return resolve(workspaceRoot, '.coder', 'snapshots');
  return join(tmpdir(), 'coder-snapshots', externalKey(abs));
}

function snapshotNameFor(abs: string, workspaceRoot?: string): string {
  const relKey = workspaceRoot
    ? sanitizeComponent(relative(workspaceRoot, abs).replace(/\\/g, '/'))
    : externalKey(abs);
  const stamp = new Date().toISOString().replace(/[^a-zA-Z0-9]+/g, '');
  return `${relKey}~${stamp}~${randomBytes(4).toString('hex')}.bak`;
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code ?? 'error';
}

export async function snapshotBeforeWrite(filePath: string, workspaceRoot?: string): Promise<WriteSnapshot> {
  try {
    const abs = resolve(filePath);
    const info = await stat(abs).catch(() => undefined);
    if (!info || !info.isFile()) return { path: null };

    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch (error) {
      return { path: null, reason: `could not read existing file (${errorCode(error)})` };
    }

    const dir = snapshotDirFor(abs, workspaceRoot);
    const snapshotPath = join(dir, snapshotNameFor(abs, workspaceRoot));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(snapshotPath, content, 'utf8');
    } catch (error) {
      return { path: null, reason: `could not write snapshot (${errorCode(error)})` };
    }
    return { path: snapshotPath };
  } catch (error) {
    return { path: null, reason: `snapshot failed (${String((error as Error)?.message ?? error)})` };
  }
}
