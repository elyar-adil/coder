/**
 * Web UI server for the multi-agent coder.
 *
 * Architecture:
 *  - HTTP static server: serves the single-page frontend from src/ui/public/
 *  - GET  /api/events   → SSE stream, pushes all MasterEvents as JSON lines
 *  - POST /api/prompt   → accepts { text, mode } from the browser
 *  - GET  /api/state    → snapshot of current tasks (for page reload / hydration)
 *  - POST /api/clarify  → { taskId, clarificationId, answer }
 *  - POST /api/model    → { name }
 *  - GET  /api/download → download a generated session/workspace artifact
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec as _exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(_exec);

import type { MasterCoordinator } from '../runtime/coordinator.js';
import type { BackendConfig, BackendType } from '../backend.js';
import { loadConfigWithPath, saveConfig, type AgentConfig, type AgentModelConfig } from '../config.js';
import type { TaskMode } from '../domain/task.js';
import { resolveModelConfig as resolveModelFromConfig } from '../model-config.js';
import { ConversationStore, type ConversationEntry } from '../store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the public directory that contains index.html.
 *
 * When running via `tsx src/ui/web.ts`  → __dirname = <root>/src/ui
 *   → <root>/src/ui/public  (exists, use it)
 *
 * When running compiled via `node dist/ui/web.js` → __dirname = <root>/dist/ui
 *   → <root>/dist/ui/public  (only if user copied assets)
 *   → fallback: <root>/src/ui/public  (always present in the repo)
 */
function findPublicDir(): string {
  const candidates = [
    resolve(__dirname, 'public'),                        // same dir / compiled copy
    resolve(__dirname, '..', '..', 'src', 'ui', 'public'), // dist/ui → src/ui/public
    resolve(__dirname, '..', 'ui', 'public'),            // dist → src sibling
  ];
  for (const c of candidates) {
    if (existsSync(resolve(c, 'index.html'))) return c;
  }
  // Last resort: return the first candidate and let 404 surface a clear error
  return candidates[0]!;
}

type ResolvedModel = { name: string; config: BackendConfig };
type ResolveModel = (name?: string) => ResolvedModel;
type PersistModelSelection = (name: string) => Promise<void>;
type ModelFormPayload = {
  alias?: string;
  model?: string;
  backend?: BackendType | '';
  baseUrl?: string;
  apiKey?: string;
  contextWindow?: number | string | null;
  temperature?: number | string | null;
  topP?: number | string | null;
  maxTokens?: number | string | null;
  extraBody?: string | Record<string, unknown> | null;
  artifactsDir?: string;
  select?: boolean;
};

export interface RunWebOptions {
  port?: number;
  verbose?: boolean;
  host?: string;
}

interface ListenResult {
  port: number;
  fallback: boolean;
}

// ── tiny helpers ──────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += String(chunk); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ── SSE helpers ───────────────────────────────────────────────────────────────

interface SseClient {
  id: string;
  res: ServerResponse;
}

export function shutdownWebServer(
  server: ReturnType<typeof createServer>,
  clients: Map<string, SseClient>,
  unsubscribe: () => void,
  timeoutMs = 1500,
): Promise<void> {
  let settled = false;
  return new Promise((resolveP) => {
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP();
    };

    try { unsubscribe(); } catch { /* ignore cleanup errors */ }
    for (const client of clients.values()) {
      try { client.res.write('event: close\ndata: {"reason":"server_shutdown"}\n\n'); } catch { /* ignore disconnected clients */ }
      try { client.res.end(); } catch { /* ignore disconnected clients */ }
    }
    clients.clear();

    try { server.closeIdleConnections?.(); } catch { /* ignore unsupported or already closed server */ }

    const timer = setTimeout(() => {
      try { server.closeAllConnections?.(); } catch { /* ignore unsupported or already closed server */ }
      finish();
    }, timeoutMs);
    timer.unref?.();

    try {
      server.close(() => finish());
    } catch {
      finish();
    }
  });
}

function sseWrite(res: ServerResponse, event: unknown): void {
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    // client disconnected
  }
}

// ── Static file map ───────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel));
}

function extOf(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  return lastDot >= 0 ? filePath.slice(lastDot).toLowerCase() : '';
}

export function safeDownloadName(filePath: string): string {
  return basename(filePath).replace(/["\\\r\n]/g, '_') || 'download';
}

function expandHomePath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return value;
}

export function resolveConfiguredPath(configuredPath: string | undefined, workspaceRoot: string, fallback: string): string {
  const raw = configuredPath?.trim() || fallback;
  const expanded = expandHomePath(raw);
  return isAbsolute(expanded) ? expanded : resolve(workspaceRoot, expanded);
}

function isExistingFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveDownloadPath(
  requestedPath: string,
  roots: { workspaceRoot: string; artifactRoot: string; sessionArtifactDir: string },
): string | undefined {
  const raw = requestedPath.trim();
  if (!raw) return undefined;
  const withoutFileScheme = raw.startsWith('file://') ? fileURLToPath(raw) : raw;
  const expanded = expandHomePath(withoutFileScheme);
  const candidates = isAbsolute(expanded)
    ? [resolve(expanded)]
    : [
      resolve(roots.sessionArtifactDir, expanded),
      resolve(roots.artifactRoot, expanded),
      resolve(roots.workspaceRoot, expanded),
    ];
  const allowedRoots = [roots.sessionArtifactDir, roots.artifactRoot, roots.workspaceRoot];
  return candidates.find((candidate) => (
    allowedRoots.some((root) => isInsideRoot(root, candidate))
    && isExistingFile(candidate)
  ));
}

function serveStatic(res: ServerResponse, filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  const mime = MIME[ext] ?? 'application/octet-stream';
  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function listenWithPortFallback(
  server: ReturnType<typeof createServer>,
  requestedPort: number,
  host: string,
  maxAttempts = 20,
): Promise<ListenResult> {
  return new Promise((resolveP, reject) => {
    let attempt = 0;

    const tryListen = (): void => {
      const port = requestedPort + attempt;
      const onError = (error: NodeJS.ErrnoException): void => {
        server.off('listening', onListening);
        if (error.code === 'EADDRINUSE' && attempt < maxAttempts) {
          attempt += 1;
          tryListen();
          return;
        }
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolveP({ port, fallback: port !== requestedPort });
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };

    tryListen();
  });
}

function modelAliasesFromConfig(config: AgentConfig): string[] {
  return Array.from(new Set([
    ...(config.model ? [config.model] : []),
    ...Object.keys(config.models ?? {}),
  ]));
}

function redactModelConfig(config: AgentModelConfig): Omit<AgentModelConfig, 'apiKey'> & { hasApiKey: boolean } {
  const { apiKey: _apiKey, ...rest } = config;
  return { ...rest, hasApiKey: Boolean(_apiKey) };
}

function redactConfig(config: AgentConfig): Omit<AgentConfig, 'apiKey' | 'models'> & {
  hasApiKey: boolean;
  models: Record<string, ReturnType<typeof redactModelConfig>>;
} {
  const { apiKey: _apiKey, models: _models, ...rest } = config;
  const models: Record<string, ReturnType<typeof redactModelConfig>> = {};
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    models[alias] = redactModelConfig(model);
  }
  return { ...rest, hasApiKey: Boolean(_apiKey), models };
}

function configModelAliases(config: AgentConfig, activeModelName: string, seedAliases: string[] = []): string[] {
  return Array.from(new Set([
    activeModelName,
    ...seedAliases,
    ...modelAliasesFromConfig(config),
  ].filter(Boolean)));
}

function parseOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} must be a number`);
  return number;
}

function parseExtraBody(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') throw new Error('extraBody must be JSON object');
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('extraBody must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function normalizeModelPayload(body: ModelFormPayload, existing?: AgentModelConfig): { alias: string; config: AgentModelConfig } {
  const alias = body.alias?.trim();
  if (!alias) throw new Error('alias is required');
  const model = body.model?.trim();
  if (!model) throw new Error('model is required');
  const backend = body.backend || undefined;
  if (backend && !['ollama', 'openai', 'anthropic'].includes(backend)) {
    throw new Error('backend must be ollama, openai, or anthropic');
  }
  const contextWindow = parseOptionalNumber(body.contextWindow, 'contextWindow');
  const temperature = parseOptionalNumber(body.temperature, 'temperature');
  const topP = parseOptionalNumber(body.topP, 'topP');
  const maxTokens = parseOptionalNumber(body.maxTokens, 'maxTokens');
  const extraBody = parseExtraBody(body.extraBody);
  const requestOptions = {
    ...(extraBody ? { extraBody } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
  const apiKey = body.apiKey?.trim();

  return {
    alias,
    config: {
      model,
      ...(body.baseUrl?.trim() ? { baseUrl: body.baseUrl.trim() } : {}),
      ...(backend ? { backend } : {}),
      ...(apiKey ? { apiKey } : existing?.apiKey ? { apiKey: existing.apiKey } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(Object.keys(requestOptions).length > 0 ? { requestOptions } : {}),
    },
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runWeb(
  master: MasterCoordinator,
  modelName: string,
  resolveModel?: ResolveModel,
  modelAliases: string[] = [],
  persistModelSelection?: PersistModelSelection,
  options: RunWebOptions = {},
): Promise<void> {
  const port = options.port ?? 3131;
  const host = options.host ?? '127.0.0.1';
  const workspaceRoot = resolve(process.cwd());

  const convStore = new ConversationStore();
  await convStore.init();
  let loadedConfig = await loadConfigWithPath();
  const sessionId = `web-session-${Date.now()}`;
  let artifactRoot = resolveConfiguredPath(loadedConfig.config.artifactsDir, workspaceRoot, '.agent-workspace/artifacts');
  let sessionArtifactDir = resolve(artifactRoot, sessionId);
  await mkdir(sessionArtifactDir, { recursive: true });
  const history: ConversationEntry[] = [];

  let activeModelName = modelName;
  let activeModelAliases = configModelAliases(loadedConfig.config, activeModelName, modelAliases);
  let activeMode: TaskMode = 'build';

  const clients = new Map<string, SseClient>();
  let clientSeq = 0;

  const eventBelongsToSession = (event: { type?: string; [key: string]: unknown }): boolean => {
    if (event.type === 'task_created' || event.type === 'task_updated') {
      const task = event.task as { sessionId?: string } | undefined;
      return task?.sessionId === sessionId;
    }
    if (event.type === 'user_visible_message') {
      return event.sessionId === sessionId;
    }
    const taskId = typeof event.taskId === 'string' ? event.taskId : undefined;
    if (taskId) return master.getTask(taskId)?.sessionId === sessionId;
    const parentTaskId = typeof event.parentTaskId === 'string' ? event.parentTaskId : undefined;
    if (parentTaskId) return master.getTask(parentTaskId)?.sessionId === sessionId;
    const subagent = event.subagent as { parentTaskId?: string } | undefined;
    if (subagent?.parentTaskId) return master.getTask(subagent.parentTaskId)?.sessionId === sessionId;
    const relatedTaskIds = Array.isArray(event.relatedTaskIds) ? event.relatedTaskIds.filter((id): id is string => typeof id === 'string') : [];
    if (relatedTaskIds.length > 0) return relatedTaskIds.some((id) => master.getTask(id)?.sessionId === sessionId);
    return false;
  };

  // Broadcast to every connected SSE client
  const broadcast = (event: unknown): void => {
    for (const client of clients.values()) {
      sseWrite(client.res, event);
    }
  };

  // Subscribe to all master events and forward to browser
  const unsubscribe = master.subscribe((event) => {
    if (!eventBelongsToSession(event)) return;
    broadcast({ channel: 'master', event });
  });



  const publicDir = findPublicDir();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // ── CORS pre-flight ──────────────────────────────────────────────────────
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    // ── SSE stream ───────────────────────────────────────────────────────────
    if (path === '/api/events' && method === 'GET') {
      const clientId = `c${++clientSeq}`;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(': connected\n\n');
      clients.set(clientId, { id: clientId, res });

      // Send current snapshot immediately so the page renders on reconnect
      const snapshot = master.listTasks?.({ sessionId }) ?? [];
      sseWrite(res, {
        channel: 'snapshot',
        tasks: snapshot,
        mode: activeMode,
        model: activeModelName,
        modelAliases: activeModelAliases,
        modelConfig: redactConfig(loadedConfig.config),
        artifactDir: sessionArtifactDir,
      });

      req.on('close', () => {
        clients.delete(clientId);
      });
      return;
    }

    // ── State snapshot ───────────────────────────────────────────────────────
    if (path === '/api/state' && method === 'GET') {
      const tasks = master.listTasks?.({ sessionId }) ?? [];
      json(res, 200, {
        tasks,
        mode: activeMode,
        model: activeModelName,
        modelAliases: activeModelAliases,
        modelConfig: redactConfig(loadedConfig.config),
        artifactDir: sessionArtifactDir,
      });
      return;
    }

    // ── Submit prompt ────────────────────────────────────────────────────────
    if (path === '/api/prompt' && method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req)) as { text?: string; mode?: TaskMode };
        const text = (body.text ?? '').trim();
        const mode = body.mode ?? activeMode;
        if (!text) { json(res, 400, { error: 'text is required' }); return; }
        activeMode = mode;
        history.push({ role: 'user', content: text });
        await convStore.save(sessionId, history);
        const taskId = await master.acceptPrompt('web-user', text, mode, history.slice(0, -1), { sessionId, artifactDir: sessionArtifactDir });
        broadcast({ channel: 'user_message', sessionId, text, mode, ts: new Date().toISOString() });
        json(res, 200, { taskId, mode });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Answer clarification ─────────────────────────────────────────────────
    if (path === '/api/clarify' && method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req)) as { taskId?: string; clarificationId?: string; answer?: string };
        if (!body.taskId || !body.clarificationId || !body.answer) {
          json(res, 400, { error: 'taskId, clarificationId, answer required' }); return;
        }
        const accepted = master.answerClarification(body.taskId, body.clarificationId, body.answer);
        if (!accepted) {
          json(res, 409, { error: 'answer must match one of the current choices' });
          return;
        }
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Switch model ─────────────────────────────────────────────────────────
    if (path === '/api/model' && method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req)) as { name?: string };
        const name = body.name?.trim();
        if (!name) { json(res, 400, { error: 'name required' }); return; }
        loadedConfig = await loadConfigWithPath();
        const next = resolveModelFromConfig(loadedConfig.config, name);
        master.setBackendConfig(next.config);
        activeModelName = name;
        if (persistModelSelection) await persistModelSelection(name);
        loadedConfig = await loadConfigWithPath();
        activeModelAliases = configModelAliases(loadedConfig.config, activeModelName, activeModelAliases);
        broadcast({
          channel: 'model_changed',
          model: activeModelName,
          modelAliases: activeModelAliases,
          modelConfig: redactConfig(loadedConfig.config),
          artifactDir: sessionArtifactDir,
          ts: new Date().toISOString(),
        });
        json(res, 200, {
          model: activeModelName,
          modelAliases: activeModelAliases,
          config: redactConfig(loadedConfig.config),
          artifactDir: sessionArtifactDir,
        });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Model configuration ─────────────────────────────────────────────────
    if (path === '/api/models' && method === 'GET') {
      loadedConfig = await loadConfigWithPath();
      artifactRoot = resolveConfiguredPath(loadedConfig.config.artifactsDir, workspaceRoot, '.agent-workspace/artifacts');
      sessionArtifactDir = resolve(artifactRoot, sessionId);
      await mkdir(sessionArtifactDir, { recursive: true });
      activeModelAliases = configModelAliases(loadedConfig.config, activeModelName, activeModelAliases);
      json(res, 200, {
        model: activeModelName,
        modelAliases: activeModelAliases,
        config: redactConfig(loadedConfig.config),
        configPath: loadedConfig.path,
        artifactRoot,
        artifactDir: sessionArtifactDir,
      });
      return;
    }

    if (path === '/api/models' && method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req)) as ModelFormPayload;
        loadedConfig = await loadConfigWithPath();
        const existing = body.alias ? loadedConfig.config.models?.[body.alias] : undefined;
        const normalized = normalizeModelPayload(body, existing);
        const nextArtifactsDir = body.artifactsDir?.trim() || loadedConfig.config.artifactsDir;
        const nextConfig: AgentConfig = {
          ...loadedConfig.config,
          model: body.select === false ? loadedConfig.config.model : normalized.alias,
          artifactsDir: nextArtifactsDir,
          models: {
            ...(loadedConfig.config.models ?? {}),
            [normalized.alias]: normalized.config,
          },
        };
        const pathWritten = await saveConfig(nextConfig, loadedConfig.path);
        loadedConfig = { config: nextConfig, path: pathWritten };
        artifactRoot = resolveConfiguredPath(nextConfig.artifactsDir, workspaceRoot, '.agent-workspace/artifacts');
        sessionArtifactDir = resolve(artifactRoot, sessionId);
        await mkdir(sessionArtifactDir, { recursive: true });
        activeModelAliases = configModelAliases(nextConfig, activeModelName, [...activeModelAliases, normalized.alias]);

        if (body.select !== false) {
          const resolved = { name: normalized.alias, config: resolveModelFromConfig(nextConfig, normalized.alias).config };
          master.setBackendConfig(resolved.config);
          activeModelName = resolved.name;
          activeModelAliases = configModelAliases(nextConfig, activeModelName, activeModelAliases);
        }

        broadcast({
          channel: 'model_changed',
          model: activeModelName,
          modelAliases: activeModelAliases,
          modelConfig: redactConfig(nextConfig),
          artifactDir: sessionArtifactDir,
          ts: new Date().toISOString(),
        });
        json(res, 200, {
          model: activeModelName,
          modelAliases: activeModelAliases,
          config: redactConfig(nextConfig),
          configPath: pathWritten,
          artifactRoot,
          artifactDir: sessionArtifactDir,
        });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ── List local Ollama models ─────────────────────────────────────────────
    if (path === '/api/ollama/models' && method === 'GET') {
      try {
        const { stdout } = await execAsync('ollama list', { timeout: 5000 });
        const lines = stdout.trim().split('\n').slice(1); // skip header
        const models = lines
          .map((line) => {
            const [name, size] = line.split(/\s+/);
            return name ? { name, size: size ?? '' } : null;
          })
          .filter((m): m is { name: string; size: string } => m !== null);
        json(res, 200, { models });
      } catch (err) {
        json(res, 200, { models: [], error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ── Switch mode ──────────────────────────────────────────────────────────
    if (path === '/api/mode' && method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req)) as { mode?: TaskMode };
        const mode = body.mode;
        if (mode !== 'build' && mode !== 'plan') {
          json(res, 400, { error: 'mode must be build|plan' }); return;
        }
        activeMode = mode;
        broadcast({ channel: 'mode_changed', mode, ts: new Date().toISOString() });
        json(res, 200, { mode });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Download generated workspace files ───────────────────────────────────
    if (path === '/api/download' && method === 'GET') {
      const requestedPath = url.searchParams.get('path') ?? '';
      const downloadPath = resolveDownloadPath(requestedPath, { workspaceRoot, artifactRoot, sessionArtifactDir });
      if (!downloadPath) {
        json(res, 404, { error: 'file not found in this session, artifact directory, or workspace' });
        return;
      }

      try {
        const stat = statSync(downloadPath);
        if (!stat.isFile()) {
          json(res, 404, { error: 'file not found' });
          return;
        }

        const fileName = safeDownloadName(downloadPath);
        res.writeHead(200, {
          'Content-Type': MIME[extOf(downloadPath)] ?? 'application/octet-stream',
          'Content-Length': String(stat.size),
          'Content-Disposition': `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        createReadStream(downloadPath).pipe(res);
      } catch {
        json(res, 404, { error: 'file not found' });
      }
      return;
    }

    // ── Static files ─────────────────────────────────────────────────────────
    let filePath = resolve(publicDir, path === '/' ? 'index.html' : path.slice(1));
    // Safety: prevent path traversal
    if (!isInsideRoot(publicDir, filePath)) {
      res.writeHead(403); res.end(); return;
    }
    if (serveStatic(res, filePath)) return;

    // SPA fallback
    const indexPath = resolve(publicDir, 'index.html');
    if (serveStatic(res, indexPath)) return;

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  const listen = await listenWithPortFallback(server, port, host);

  const url = `http://${host}:${listen.port}`;
  if (listen.fallback) {
    console.log(`\n  Port ${port} is busy; using ${listen.port} instead.`);
  }
  console.log(`\n  🌐  Coder Web UI  →  ${url}`);
  console.log(`  📁  Serving static from: ${publicDir}\n`);

  // Keep the process alive; clean up on signal
  await new Promise<void>((resolveP) => {
    let shuttingDown = false;
    const cleanupSignalHandlers = (): void => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n  ${signal} received; shutting down Coder Web UI...`);
      void shutdownWebServer(server, clients, unsubscribe).then(() => {
        cleanupSignalHandlers();
        console.log('  Coder Web UI stopped.');
        resolveP();
      });
    };
    const onSigint = (): void => shutdown('SIGINT');
    const onSigterm = (): void => shutdown('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  });
}
