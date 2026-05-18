import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { PromptTask } from './types.js';

const BASE = join(homedir(), '.coder');

export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
}

export class ConversationStore {
  private dir: string;

  constructor() {
    this.dir = join(BASE, 'conversations');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async save(sessionId: string, history: ConversationEntry[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${sessionId}.json`), JSON.stringify(history, null, 2), 'utf8');
  }

  async load(sessionId: string): Promise<ConversationEntry[]> {
    try {
      const raw = await readFile(join(this.dir, `${sessionId}.json`), 'utf8');
      return JSON.parse(raw) as ConversationEntry[];
    } catch {
      return [];
    }
  }

  async list(): Promise<Array<{ id: string; entries: number; modified: string }>> {
    try {
      const files = await readdir(this.dir);
      const results: Array<{ id: string; entries: number; modified: string }> = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(this.dir, f), 'utf8');
          const data = JSON.parse(raw) as ConversationEntry[];
          const stat = await import('node:fs/promises').then((fs) => fs.stat(join(this.dir, f)));
          results.push({
            id: f.replace('.json', ''),
            entries: data.length,
            modified: stat.mtime.toISOString(),
          });
        } catch { /* skip corrupt */ }
      }
      return results.sort((a, b) => b.modified.localeCompare(a.modified));
    } catch {
      return [];
    }
  }

  async remove(sessionId: string): Promise<void> {
    try { await rm(join(this.dir, `${sessionId}.json`), { force: true }); } catch { /* ignore */ }
  }
}

export class TaskStore {
  private dir: string;

  constructor(sub = 'tasks') {
    this.dir = join(BASE, sub);
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async save(task: PromptTask): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${task.taskId}.json`);
    await writeFile(path, JSON.stringify(task, null, 2), 'utf8');
  }

  async load(taskId: string): Promise<PromptTask | undefined> {
    try {
      const raw = await readFile(join(this.dir, `${taskId}.json`), 'utf8');
      return JSON.parse(raw) as PromptTask;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<PromptTask[]> {
    try {
      const files = await readdir(this.dir);
      const tasks: PromptTask[] = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(this.dir, f), 'utf8');
          tasks.push(JSON.parse(raw));
        } catch { /* skip corrupt */ }
      }
      return tasks;
    } catch {
      return [];
    }
  }

  async remove(taskId: string): Promise<void> {
    try {
      await rm(join(this.dir, `${taskId}.json`), { force: true });
    } catch { /* ignore */ }
  }
}

export class ResponseCache {
  private cache = new Map<string, { result: string; ts: number }>();
  private ttl: number;

  constructor(ttlMs = 300_000) {
    this.ttl = ttlMs;
  }

  get(model: string, systemPrompt: string, messages: string): string | undefined {
    const key = this.hash(model, systemPrompt, messages);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  set(model: string, systemPrompt: string, messages: string, result: string): void {
    const key = this.hash(model, systemPrompt, messages);
    this.cache.set(key, { result, ts: Date.now() });
  }

  invalidate(model: string, systemPrompt: string, messages: string): void {
    this.cache.delete(this.hash(model, systemPrompt, messages));
  }

  clear(): void {
    this.cache.clear();
  }

  private hash(model: string, systemPrompt: string, messages: string): string {
    return createHash('sha256').update(model + '|' + systemPrompt + '|' + messages).digest('hex');
  }
}
