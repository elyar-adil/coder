import { resolve } from 'node:path';

import {
  CrossProcessLockManager,
  LockConflictError,
  type CrossProcessLockHandle,
  type LiveLockHolder,
} from './file-lock.js';

export { LockConflictError, type LiveLockHolder } from './file-lock.js';

export type ReleaseLock = () => Promise<void>;

export interface FileLockOptions {
  timeoutMs?: number;
  purpose?: string;
  session?: string;
}

/**
 * Per-path write lock that is safe both within one process (concurrent agent
 * instances) and across processes (multiple runtimes on the same workspace).
 *
 * In-process: a FIFO promise chain per resolved path serializes concurrent
 * acquirers. Cross-process: an O_EXCL lock file under the runtime lock dir.
 * The returned release function is bound to the acquisition token and is
 * idempotent — calling it twice can never hand the lock to another waiter
 * while the original holder is still inside its critical section.
 */
export class FileLockManager {
  private readonly cross: CrossProcessLockManager;
  private readonly chains = new Map<string, Promise<void>>();

  constructor(lockDir?: string) {
    this.cross = new CrossProcessLockManager(lockDir);
  }

  /** Diagnostics: who (if anyone) currently holds the cross-process lock. */
  async holder(path: string): Promise<LiveLockHolder | undefined> {
    return this.cross.holder(resolve(path));
  }

  async acquire(path: string, timeoutMs = 30_000, options: Omit<FileLockOptions, 'timeoutMs'> = {}): Promise<ReleaseLock> {
    const key = resolve(path);
    const previous = this.chains.get(key) ?? Promise.resolve();
    let openGate!: () => void;
    const gate = new Promise<void>((releaseTurn) => {
      openGate = releaseTurn;
    });
    const chain = previous.then(() => gate);
    this.chains.set(key, chain);

    // Wait for the in-process turn. In-process holders always release (the
    // release path cannot throw past its finally), so no timeout is needed here.
    await previous;

    let handle: CrossProcessLockHandle;
    try {
      handle = await this.cross.acquire(key, {
        timeoutMs: Math.max(100, timeoutMs),
        ...options,
      });
    } catch (error) {
      openGate();
      this.dropChain(key, chain);
      throw error;
    }

    let released = false;
    return async (): Promise<void> => {
      if (released) return; // idempotent second release
      released = true;
      try {
        await handle.release();
      } finally {
        openGate();
        this.dropChain(key, chain);
      }
    };
  }

  private dropChain(key: string, chain: Promise<void>): void {
    if (this.chains.get(key) === chain) this.chains.delete(key);
  }
}
