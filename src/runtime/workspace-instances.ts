import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { atomicReplaceFile, selfStartedAt } from './file-lock.js';

const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_AFTER_MS = 30_000;

export interface WorkspaceInstanceInfo {
  pid: number;
  startedAt: number;
  workspace: string;
  session?: string;
  nonce: string;
  heartbeatAt: string;
}

interface RuntimeDirs {
  dir: string;
}

function instancesDir(): RuntimeDirs {
  const base = process.env.CODER_DATA_HOME?.trim() || resolve(homedir(), '.coder');
  return { dir: resolve(base, 'runtime', 'instances') };
}

function instanceFile(workspaceRoot: string, pid: number): string {
  const key = createHash('sha1').update(resolve(workspaceRoot)).digest('hex').slice(0, 16);
  return join(instancesDir().dir, `${key}.${pid}.json`);
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function heartbeatFile(path: string, info: WorkspaceInstanceInfo): Promise<void> {
  info.heartbeatAt = new Date().toISOString();
  await mkdir(instancesDir().dir, { recursive: true });
  await atomicReplaceFile(path, `${JSON.stringify(info, null, 2)}\n`);
}

/**
 * Registers this process as an active instance of `workspaceRoot` and starts a
 * heartbeat. Returns a cleanup function that removes the registration (also
 * installed on process exit). Other instances whose pid is dead or whose
 * heartbeat is older than the stale window are ignored by `otherInstances`.
 */
export async function registerWorkspaceInstance(workspaceRoot: string, session?: string): Promise<() => Promise<void>> {
  const info: WorkspaceInstanceInfo = {
    pid: process.pid,
    startedAt: selfStartedAt(),
    workspace: resolve(workspaceRoot),
    ...(session ? { session } : {}),
    nonce: randomUUID(),
    heartbeatAt: new Date().toISOString(),
  };
  const path = instanceFile(workspaceRoot, info.pid);
  await mkdir(instancesDir().dir, { recursive: true });
  await atomicReplaceFile(path, `${JSON.stringify(info, null, 2)}\n`);

  const timer = setInterval(() => {
    void heartbeatFile(path, info).catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(timer);
    await rm(path, { force: true }).catch(() => undefined);
  };
  process.once('exit', () => { void cleanup(); });
  return cleanup;
}

function isLive(info: WorkspaceInstanceInfo, mtimeMs: number): boolean {
  if (!processAlive(info.pid)) return false;
  if (mtimeMs > 0 && Date.now() - mtimeMs > STALE_AFTER_MS) return false;
  return true;
}

/** Live instances of the same workspace other than this process. */
export async function otherWorkspaceInstances(workspaceRoot: string): Promise<WorkspaceInstanceInfo[]> {
  const dir = instancesDir().dir;
  const key = createHash('sha1').update(resolve(workspaceRoot)).digest('hex').slice(0, 16);
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((name) => name.startsWith(`${key}.`) && name.endsWith('.json'));
  } catch {
    return [];
  }
  const others: WorkspaceInstanceInfo[] = [];
  for (const file of files) {
    const path = join(dir, file);
    try {
      const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      const parsed = JSON.parse(raw) as WorkspaceInstanceInfo;
      if (typeof parsed.pid !== 'number') continue;
      if (parsed.pid === process.pid) continue;
      if (isLive(parsed, info.mtimeMs)) others.push(parsed);
    } catch {
      continue;
    }
  }
  return others.sort((a, b) => a.pid - b.pid);
}

/** Touch helper exposed for tests. */
export async function touchInstanceFile(workspaceRoot: string, pid: number): Promise<void> {
  const path = instanceFile(workspaceRoot, pid);
  const now = new Date();
  await utimes(path, now, now).catch(async () => {
    await writeFile(path, '').catch(() => undefined);
  });
}
