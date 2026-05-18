import { resolve } from 'node:path';

import type { ReleaseLock } from '../domain/task.js';

export class FileLockManager {
  private active = new Set<string>();
  private waiters = new Map<string, Array<() => void>>();

  async acquire(path: string): Promise<ReleaseLock> {
    const key = resolve(path);
    if (!this.active.has(key)) {
      this.active.add(key);
      return () => this.release(key);
    }

    await new Promise<void>((resolveWait) => {
      const queue = this.waiters.get(key) ?? [];
      queue.push(resolveWait);
      this.waiters.set(key, queue);
    });

    this.active.add(key);
    return () => this.release(key);
  }

  private release(key: string): void {
    this.active.delete(key);
    const queue = this.waiters.get(key);
    const next = queue?.shift();
    if (!queue || queue.length === 0) {
      this.waiters.delete(key);
    }
    next?.();
  }
}
