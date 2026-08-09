import { randomUUID } from 'node:crypto';
import type { TelemetryEvent } from './domain/task.js';

export class TelemetryStore {
  private events: TelemetryEvent[] = [];

  add(event: Omit<TelemetryEvent, 'ts'> & { ts?: string }): void {
    this.events.push({ ...event, ts: event.ts ?? new Date().toISOString() });
    if (this.events.length > 5000) this.events.shift();
  }

  listByTask(taskId: string, limit = 100): TelemetryEvent[] {
    return this.events.filter((e) => e.taskId === taskId).slice(-limit);
  }

  listRecent(limit = 100): TelemetryEvent[] {
    return this.events.slice(-limit);
  }

  newTraceId(): string {
    return randomUUID();
  }
}

export const telemetry = new TelemetryStore();
