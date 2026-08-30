import { resolve } from 'node:path';

type ReleaseLock = () => void | Promise<void>;

export class FileLockManager {
  private active = new Set<string>();
  private waiters = new Map<string, Array<{ resume: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>>();

  async acquire(path: string, timeoutMs = 30_000): Promise<ReleaseLock> {
    const key = resolve(path);
    if (!this.active.has(key)) {
      this.active.add(key);
      return () => this.release(key);
    }

    await new Promise<void>((resolveWait, reject) => {
      const queue = this.waiters.get(key) ?? [];
      const waiter = {
        resume: resolveWait,
        reject,
        timer: setTimeout(() => {
          const current = this.waiters.get(key);
          const index = current?.indexOf(waiter) ?? -1;
          if (index >= 0) current!.splice(index, 1);
          if (current?.length === 0) this.waiters.delete(key);
          reject(new Error(`Timed out waiting for write lock: ${key}`));
        }, Math.max(100, timeoutMs)),
      };
      queue.push(waiter);
      this.waiters.set(key, queue);
    });

    this.active.add(key);
    return () => this.release(key);
  }

  private release(key: string): void {
    const queue = this.waiters.get(key);
    const next = queue?.shift();
    if (!queue || queue.length === 0) {
      this.waiters.delete(key);
    }
    if (next) {
      clearTimeout(next.timer);
      next.resume();
    } else {
      this.active.delete(key);
    }
  }
}
