import { FileLockManager } from '../../src/runtime/locks.js';

/**
 * Augment a tool context with a real cross-process write lock provider rooted
 * at `lockDir`. Tests that pass a runtime-like context to executeTool must
 * wire this — withWriteLock refuses unlocked writes when a context is present.
 */
export function withWriteLockProvider<T extends object>(context: T, lockDir: string): T & {
  acquireWriteLock: (path: string) => Promise<() => Promise<void>>;
} {
  const locks = new FileLockManager(lockDir);
  return {
    ...context,
    acquireWriteLock: (path: string) => locks.acquire(path),
  };
}
