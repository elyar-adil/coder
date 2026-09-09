import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

const LOCK_FORMAT_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;

export interface LockHolderInfo {
  pid: number;
  /** Approximate epoch ms of the holder process start; used to defeat pid reuse. */
  startedAt: number;
  nonce: string;
  purpose: string;
  target: string;
  acquiredAt: string;
  session?: string;
}

export interface LiveLockHolder extends LockHolderInfo {
  /** Whether the holder process was verifiably alive at inspection time. */
  live: boolean;
}

export class LockConflictError extends Error {
  readonly holder?: LiveLockHolder;

  constructor(message: string, holder?: LiveLockHolder) {
    super(message);
    this.name = 'LockConflictError';
    this.holder = holder;
  }
}

export interface CrossProcessLockOptions {
  /** Total time to wait for the lock before failing with LockConflictError. */
  timeoutMs?: number;
  /** Diagnostic label, e.g. "file" or "session:<id>". */
  purpose?: string;
  /** Owning session id, when the lock guards session-scoped state. */
  session?: string;
}

export interface CrossProcessLockHandle {
  /** Idempotent: releasing twice is a no-op the second time. */
  release(): Promise<void>;
  readonly nonce: string;
  readonly path: string;
}

export function defaultLockDir(): string {
  const base = process.env.CODER_DATA_HOME?.trim() || resolve(homedir(), '.coder');
  return resolve(base, 'runtime', 'locks');
}

function lockKey(target: string): string {
  return resolve(target);
}

function lockFileName(target: string): string {
  return `${createHash('sha1').update(lockKey(target)).digest('hex')}.lock`;
}

// ── Process liveness ─────────────────────────────────────────────────────────

let cachedSelfStart: number | undefined;

/** Epoch ms this Node process started (second precision, like `ps lstart`). */
export function selfStartedAt(): number {
  if (cachedSelfStart === undefined) {
    cachedSelfStart = Math.floor((Date.now() - process.uptime() * 1000) / 1000) * 1000;
  }
  return cachedSelfStart;
}

const startTimeCache = new Map<number, number | undefined>();

async function processStartTime(pid: number): Promise<number | undefined> {
  if (pid === process.pid) return selfStartedAt();
  if (startTimeCache.has(pid)) return startTimeCache.get(pid);
  let value: number | undefined;
  try {
    if (process.platform !== 'win32') {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5_000 });
      const parsed = Date.parse(stdout.trim());
      if (Number.isFinite(parsed)) value = parsed;
    }
  } catch {
    value = undefined;
  }
  startTimeCache.set(pid, value);
  return value;
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

/** True when the recorded holder still owns the lock: process alive and, when
 * verifiable, its start time matches the recorded one (defeats pid reuse). */
async function holderIsLive(info: LockHolderInfo): Promise<boolean> {
  if (!processAlive(info.pid)) return false;
  const actual = await processStartTime(info.pid);
  if (actual === undefined) return true;
  return Math.abs(actual - info.startedAt) < 1_500;
}

// ── Manager ──────────────────────────────────────────────────────────────────

/** Nonces of locks currently held by this process, keyed by resolved target.
 * Process-wide (not per-manager) so two managers in one process — e.g. two
 * AgentRuntimes — still recognize each other's live locks instead of stealing
 * them as "same-pid leaks". */
const processHeldNonces = new Map<string, Set<string>>();

function processHolds(key: string): boolean {
  const set = processHeldNonces.get(key);
  return Boolean(set && set.size > 0);
}

function trackHeld(key: string, nonce: string): void {
  const set = processHeldNonces.get(key) ?? new Set<string>();
  set.add(nonce);
  processHeldNonces.set(key, set);
}

function untrackHeld(key: string, nonce: string): void {
  const set = processHeldNonces.get(key);
  if (!set) return;
  set.delete(nonce);
  if (set.size === 0) processHeldNonces.delete(key);
}

interface ReadLockResult {
  info?: LockHolderInfo;
  corrupt: boolean;
  missing: boolean;
}

async function readLockFile(path: string): Promise<ReadLockResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    return { corrupt: false, missing: (error as NodeJS.ErrnoException).code === 'ENOENT' };
  }
  try {
    const parsed = JSON.parse(raw) as LockHolderInfo & { v?: number };
    if (parsed.v !== LOCK_FORMAT_VERSION || typeof parsed.pid !== 'number' || typeof parsed.nonce !== 'string') {
      return { corrupt: true, missing: false };
    }
    return { info: parsed, corrupt: false, missing: false };
  } catch {
    return { corrupt: true, missing: false };
  }
}

export class CrossProcessLockManager {
  private readonly dir: string;

  constructor(lockDir: string = defaultLockDir()) {
    this.dir = resolve(lockDir);
  }

  lockPath(target: string): string {
    return resolve(this.dir, lockFileName(target));
  }

  /** Current holder metadata for diagnostics, if any lock file exists. */
  async holder(target: string): Promise<LiveLockHolder | undefined> {
    const path = this.lockPath(target);
    const read = await readLockFile(path);
    if (!read.info) return undefined;
    return { ...read.info, live: await holderIsLive(read.info) };
  }

  async acquire(target: string, options: CrossProcessLockOptions = {}): Promise<CrossProcessLockHandle> {
    const key = lockKey(target);
    const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;
    const info: LockHolderInfo = {
      pid: process.pid,
      startedAt: selfStartedAt(),
      nonce: randomUUID(),
      purpose: options.purpose ?? 'file',
      target: key,
      acquiredAt: new Date().toISOString(),
      ...(options.session ? { session: options.session } : {}),
    };
    const payload = `${JSON.stringify({ v: LOCK_FORMAT_VERSION, ...info }, null, 2)}\n`;

    await mkdir(this.dir, { recursive: true });

    let lastHolder: LiveLockHolder | undefined;
    let stealAttempts = 0;
    for (;;) {
      if (processHolds(key)) {
        // Another manager instance in this process holds the lock; the
        // in-process layer above must serialize. Reaching here means a
        // leaked handle or a second runtime in the same process.
        throw new LockConflictError(
          `write lock for ${key} is held by this process (pid ${process.pid}); a previous acquisition was never released`,
          { ...(await this.holderOrSelf(key, info)), live: true },
        );
      }
      const path = this.lockPath(key);
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(path, 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const read = await readLockFile(path);
        if (read.info) {
          const sameProcessLeak = read.info.pid === process.pid && !processHolds(key);
          const live = sameProcessLeak ? false : await holderIsLive(read.info);
          lastHolder = { ...read.info, live: !sameProcessLeak && live };
          if (live) {
            if (Date.now() >= deadline) {
              throw this.conflict(key, lastHolder);
            }
            await sleep(POLL_INTERVAL_MS);
            continue;
          }
          // Stale lock: holder process is gone, the pid was reused, or the
          // same process leaked an unreleased lock — steal it.
          stealAttempts += 1;
          if (stealAttempts > 10) throw this.conflict(key, lastHolder);
          await rm(path, { force: true }).catch(() => undefined);
          continue;
        }
        if (read.corrupt) {
          // Unparseable lock file is stale by definition.
          stealAttempts += 1;
          if (stealAttempts > 10) throw this.conflict(key, lastHolder);
          await rm(path, { force: true }).catch(() => undefined);
          continue;
        }
        // missing: someone removed it between EEXIST and read — retry immediately.
        continue;
      }
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.close();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }
      trackHeld(key, info.nonce);
      let released = false;
      return {
        nonce: info.nonce,
        path,
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          untrackHeld(key, info.nonce);
          const current = await readLockFile(path);
          if (current.info?.nonce === info.nonce) {
            await rm(path, { force: true }).catch(() => undefined);
          }
        },
      };
    }
  }

  private async holderOrSelf(key: string, fallback: LockHolderInfo): Promise<LockHolderInfo> {
    const found = await this.holder(key);
    return found ?? { ...fallback, target: key };
  }

  private conflict(key: string, holder?: LiveLockHolder): LockConflictError {
    if (!holder) {
      return new LockConflictError(`write lock for ${key} could not be acquired before timeout`);
    }
    const who = holder.session ? `session ${holder.session}` : holder.purpose;
    const state = holder.live ? 'active' : 'possibly stale';
    return new LockConflictError(
      `write lock for ${key} is held by another process (pid ${holder.pid}, ${who}, ${state}, acquired ${holder.acquiredAt}). ` +
        `Wait for it to finish${holder.live ? ', or terminate pid ' + holder.pid + ' if it is wedged' : ''}.`,
      holder,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

/** Atomic file replace used by instance heartbeat files etc. */
export async function atomicReplaceFile(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, content, 'utf8');
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
