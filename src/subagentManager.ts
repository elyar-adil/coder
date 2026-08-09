import type { SubAgentTask } from './domain/task.js';

export class SubagentManager {
  private queue: string[] = [];
  private running = new Set<string>();

  constructor(private readonly maxConcurrent = 2) {}

  enqueue(task: SubAgentTask): void {
    this.queue.push(task.taskId);
  }

  canStart(): boolean {
    return this.running.size < this.maxConcurrent && this.queue.length > 0;
  }

  next(): string | undefined {
    if (!this.canStart()) return undefined;
    const id = this.queue.shift();
    if (!id) return undefined;
    this.running.add(id);
    return id;
  }

  done(id: string): void {
    this.running.delete(id);
  }

  status(): { queued: number; running: number; maxConcurrent: number } {
    return { queued: this.queue.length, running: this.running.size, maxConcurrent: this.maxConcurrent };
  }
}
