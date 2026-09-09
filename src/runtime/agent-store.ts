import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type { PersistedAgentSession } from '../domain/agent.js';

const writes = new Map<string, Promise<void>>();

function validSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(sessionId)) {
    throw new Error('Invalid session id. Use letters, numbers, dot, underscore, or dash.');
  }
}

async function replaceFile(temp: string, target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EEXIST', 'EACCES'].includes(code ?? '')) throw error;
      await rm(target, { force: true }).catch(() => undefined);
      await new Promise((resolveWait) => setTimeout(resolveWait, (attempt + 1) * 5));
    }
  }
  throw lastError;
}

export class AgentRuntimeStore {
  private readonly dir: string;

  constructor(baseDir = process.env.CODER_DATA_HOME?.trim() || resolve(homedir(), '.coder')) {
    this.dir = resolve(baseDir, 'runtime');
  }

  /** Root directory for runtime state (sessions, archives, locks, instances). */
  get runtimeDir(): string {
    return this.dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private path(sessionId: string): string {
    validSessionId(sessionId);
    return resolve(this.dir, `${sessionId}.json`);
  }

  /** Absolute path of the persisted session snapshot (cross-process lock target). */
  sessionPath(sessionId: string): string {
    return this.path(sessionId);
  }

  async save(snapshot: PersistedAgentSession): Promise<void> {
    const path = this.path(snapshot.session.sessionId);
    const payload = `${JSON.stringify(snapshot, null, 2)}\n`;
    const key = path.toLowerCase();
    const previous = writes.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await mkdir(this.dir, { recursive: true });
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, payload, 'utf8');
        await replaceFile(temp, path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    writes.set(key, next);
    try { await next; } finally { if (writes.get(key) === next) writes.delete(key); }
  }

  async load(sessionId: string): Promise<PersistedAgentSession | undefined> {
    const path = this.path(sessionId);
    await writes.get(path.toLowerCase())?.catch(() => undefined);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as PersistedAgentSession;
      return parsed.version === 1 ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** Duplicate one persisted session file under a new session id (used by /fork). */
  async copySession(sourceSessionId: string, newSessionId: string): Promise<void> {
    const source = await this.load(sourceSessionId);
    if (!source) throw new Error(`Session ${sourceSessionId} is not persisted yet.`);
    const snapshot: PersistedAgentSession = {
      version: 1,
      session: { ...source.session, sessionId: newSessionId },
      instances: source.instances.map((instance) => ({ ...instance, sessionId: newSessionId })),
    };
    await this.save(snapshot);
    for (const archive of await this.loadArchives(sourceSessionId)) {
      await this.saveArchive(newSessionId, archive.instanceId, archive.seq, archive.messages);
    }
  }

  async list(): Promise<Array<{ sessionId: string; messages: number; updatedAt: string }>> {
    await Promise.all([...writes.values()].map((write) => write.catch(() => undefined)));
    let files: string[] = [];
    try { files = await readdir(this.dir); } catch { return []; }
    const sessions: Array<{ sessionId: string; messages: number; updatedAt: string }> = [];
    for (const file of files.filter((name) => name.endsWith('.json'))) {
      try {
        const parsed = JSON.parse(await readFile(resolve(this.dir, file), 'utf8')) as PersistedAgentSession;
        if (parsed.version !== 1) continue;
        sessions.push({
          sessionId: parsed.session.sessionId,
          messages: parsed.session.messages.length,
          updatedAt: parsed.session.updatedAt,
        });
      } catch { /* skip invalid snapshots */ }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async remove(sessionId: string): Promise<void> {
    const path = this.path(sessionId);
    await writes.get(path.toLowerCase())?.catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    await this.removeArchives(sessionId);
  }

  // ── Compaction archives ─────────────────────────────────────────────────────

  private archivesDir(sessionId: string): string {
    validSessionId(sessionId);
    return resolve(this.dir, 'archives', sessionId);
  }

  /** Persist the messages removed by compaction so agents can search them later. */
  async saveArchive(sessionId: string, instanceId: string, seq: number, messages: unknown[]): Promise<void> {
    const dir = this.archivesDir(sessionId);
    const path = resolve(dir, `${instanceId}.${String(seq).padStart(4, '0')}.json`);
    const payload = `${JSON.stringify({ version: 1, instanceId, seq, messages }, null, 2)}\n`;
    await mkdir(dir, { recursive: true });
    await writeFile(path, payload, 'utf8');
  }

  /** Load archived messages for one instance (or all instances of a session). */
  async loadArchives(sessionId: string, instanceId?: string): Promise<Array<{ instanceId: string; seq: number; messages: any[] }>> {
    const dir = this.archivesDir(sessionId);
    let files: string[] = [];
    try { files = await readdir(dir); } catch { return []; }
    const archives: Array<{ instanceId: string; seq: number; messages: any[] }> = [];
    for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
      if (instanceId && !file.startsWith(`${instanceId}.`)) continue;
      try {
        const parsed = JSON.parse(await readFile(resolve(dir, file), 'utf8')) as { version: number; instanceId: string; seq: number; messages: any[] };
        if (parsed.version !== 1 || !Array.isArray(parsed.messages)) continue;
        archives.push({ instanceId: parsed.instanceId, seq: parsed.seq, messages: parsed.messages });
      } catch { /* skip invalid archives */ }
    }
    return archives;
  }

  async removeArchives(sessionId: string): Promise<void> {
    await rm(this.archivesDir(sessionId), { recursive: true, force: true }).catch(() => undefined);
  }

  async flush(): Promise<void> {
    await Promise.all([...writes.values()].map((write) => write.catch(() => undefined)));
  }
}

