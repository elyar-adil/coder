/**
 * config.ts — .agentrc config file support.
 *
 * Merges .agentrc from the current project and user home. User values win,
 * and interactive changes are persisted to the user-scoped file.
 *
 * Format: JSON with optional fields:
 *  {
 *    "baseUrl": "http://localhost:11434",
 *    "model": "gemma4:31b-cloud",
 *    "backend": "openai",
 *    "apiKey": "sk-...",
 *    "artifactsDir": ".agent-workspace/artifacts",
 *    "providers": {
 *      "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "sk-..." }
 *    },
 *    "models": {
 *      "fast": {
 *        "provider": "openrouter",
 *        "model": "provider-model-id",
 *        "requestOptions": {
 *          "extraBody": {
 *            "provider_option": true
 *          }
 *        }
 *      }
 *    }
 *  }
 *
 * `providers` hold the connection (baseUrl + apiKey + optional backend) once;
 * `models` reference a provider by name so one endpoint can back many model
 * aliases without copying the API key into every entry.
 *
 * Legacy configs that carry baseUrl/apiKey/backend inside `models` entries
 * (or only at the top level) are migrated on load: a provider is synthesized
 * from the first distinct connection, later duplicates are deduped into it,
 * and the top-level baseUrl/apiKey/backend keep working as the default
 * connection.
 */

import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { BackendType } from './backend.js';

const BACKENDS = ['ollama', 'openai', 'anthropic'];

export interface AgentProviderConfig {
  baseUrl: string;
  apiKey?: string;
  /** Optional backend override; otherwise detected from the base URL. */
  backend?: BackendType;
}

export interface AgentConfig {
  baseUrl?: string;
  model?: string;
  backend?: BackendType;
  apiKey?: string;
  policyLevel?: 'strict' | 'moderate' | 'off';
  artifactsDir?: string;
  theme?: string;
  providers?: Record<string, AgentProviderConfig>;
  models?: Record<string, AgentModelConfig>;
}

export interface AgentModelConfig {
  wireApi?: 'chat' | 'responses';
  /** Provider connection to route through (a key of `providers`). */
  provider?: string;
  /** Legacy flat connection fields; honored and migrated to `provider`. */
  baseUrl?: string;
  backend?: BackendType;
  apiKey?: string;
  model: string;
  contextWindow?: number;
  requestOptions?: {
    extraBody?: Record<string, unknown>;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
  };
}

const CONFIG_FILES = ['.agentrc', '.agentrc.json'];
const configWrites = new Map<string, Promise<void>>();

async function replaceConfigFile(tempPath: string, path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(tempPath, path);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EACCES') throw error;
      await rm(path, { force: true }).catch(() => undefined);
      await new Promise((resolveP) => setTimeout(resolveP, (attempt + 1) * 4));
    }
  }
  throw lastError;
}

function configHome(): string {
  return process.env.CODER_CONFIG_HOME?.trim() || homedir();
}

export interface LoadedConfig {
  config: AgentConfig;
  /** User-scoped config path used by interactive provider/model management. */
  path?: string;
}

function mergeConfig(project: AgentConfig, user: AgentConfig): AgentConfig {
  return {
    ...project,
    ...user,
    providers: Object.keys(project.providers ?? {}).length || Object.keys(user.providers ?? {}).length
      ? { ...(project.providers ?? {}), ...(user.providers ?? {}) }
      : undefined,
    models: Object.keys(project.models ?? {}).length || Object.keys(user.models ?? {}).length
      ? { ...(project.models ?? {}), ...(user.models ?? {}) }
      : undefined,
  };
}

/**
 * Resolves the effective connection for a model entry: its named provider,
 * falling back to inline legacy fields and finally the top-level default
 * connection. Returns undefined when nothing supplies a base URL.
 */
export function modelConnection(config: AgentConfig, model: AgentModelConfig): AgentProviderConfig | undefined {
  const provider = model.provider !== undefined ? config.providers?.[model.provider] : undefined;
  const baseUrl = provider?.baseUrl ?? model.baseUrl ?? config.baseUrl;
  if (!baseUrl) return undefined;
  return {
    baseUrl,
    ...(provider?.apiKey ?? model.apiKey ?? config.apiKey ? { apiKey: provider?.apiKey ?? model.apiKey ?? config.apiKey } : {}),
    ...(provider?.backend ?? model.backend ?? config.backend ? { backend: provider?.backend ?? model.backend ?? config.backend } : {}),
  };
}

interface RawModelEntry extends AgentModelConfig {
  /** Legacy fields tolerated during parsing, migrated into `providers`. */
  baseUrl?: string;
  apiKey?: string;
  backend?: BackendType;
}

function parseProviderEntry(name: string, raw: unknown): AgentProviderConfig {
  const value = raw as Partial<AgentProviderConfig> | undefined;
  if (typeof value !== 'object' || value === null || typeof value.baseUrl !== 'string' || !value.baseUrl.trim()) {
    throw new Error(`Invalid provider "${name}" in config. Each provider needs a string "baseUrl".`);
  }
  return {
    baseUrl: value.baseUrl,
    ...(typeof value.apiKey === 'string' && value.apiKey ? { apiKey: value.apiKey } : {}),
    ...(value.backend !== undefined
      ? (BACKENDS.includes(value.backend) ? { backend: value.backend }
        : (() => { throw new Error(`Invalid backend "${value.backend}" for provider "${name}". Use "openai", "anthropic", or "ollama".`); })())
      : {}),
  };
}

/** Key for a synthesized legacy connection: URL identifies the endpoint. */
function legacyProviderKey(entry: { baseUrl: string; backend?: BackendType }): string {
  const host = entry.baseUrl.replace(/^https?:\/\//, '').replace(/^www\./, '');
  return `${(entry.backend ?? 'openai').replace(/[^a-z0-9]/gi, '')}-${host.replace(/[^a-z0-9]/gi, '').slice(0, 32).toLowerCase()}`;
}

/**
 * Rewrites legacy models (baseUrl/apiKey/backend on each alias, or only the
 * top-level defaults) into the two-layer `providers` + `models` shape. Idempotent.
 */
function migrateLegacyModels(parsed: AgentConfig): void {
  const providers = { ...(parsed.providers ?? {}) };
  const models = parsed.models ? { ...parsed.models } : undefined;
  let nextProviderKey = 0;

  const ensureProvider = (connection: { baseUrl: string; apiKey?: string; backend?: BackendType }): string => {
    const key = legacyProviderKey(connection);
    const existing = providers[key];
    if (!existing) {
      providers[key] = {
        baseUrl: connection.baseUrl,
        ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
        ...(connection.backend ? { backend: connection.backend } : {}),
      };
      return key;
    }
    // Same endpoint: adopt the richer connection (a real key wins over empty).
    if (connection.apiKey && existing.apiKey !== connection.apiKey) {
      providers[key] = { ...existing, apiKey: connection.apiKey };
    }
    return key;
  };

  if (models) {
    for (const [alias, entryRaw] of Object.entries(models)) {
      const entry = entryRaw as RawModelEntry;
      if (entry.provider) continue;
      if (entry.baseUrl) {
        entry.provider = ensureProvider({ baseUrl: entry.baseUrl, apiKey: entry.apiKey, backend: entry.backend });
        delete (entry as RawModelEntry).baseUrl;
        delete (entry as RawModelEntry).apiKey;
        delete (entry as RawModelEntry).backend;
      } else if (parsed.baseUrl) {
        // Endpoint came from the top level; point at the default connection
        // once it is synthesized below.
        entry.provider = '';
        delete (entry as RawModelEntry).backend;
        delete (entry as RawModelEntry).apiKey;
      } else if (entry.backend && !providers.default) {
        entry.provider = `legacy-${nextProviderKey++}`;
        providers[entry.provider] = { baseUrl: '', backend: entry.backend };
        delete (entry as RawModelEntry).backend;
      }
    }
  }

  // Synthesize the default connection from the top level so the placeholder
  // references above (and env-free runs) resolve to it.
  if (parsed.baseUrl || parsed.apiKey || parsed.backend) {
    const hasPlaceholder = Object.values(models ?? {}).some((entry) => (entry as RawModelEntry).provider === '');
    if (parsed.baseUrl) {
      const key = ensureProvider({ baseUrl: parsed.baseUrl, apiKey: parsed.apiKey, backend: parsed.backend });
      if (hasPlaceholder) {
        for (const entry of Object.values(models ?? {})) {
          if ((entry as RawModelEntry).provider === '') (entry as RawModelEntry).provider = key;
        }
      }
    } else if (hasPlaceholder && !parsed.baseUrl) {
      // Only a key/backend at top level: synthesize a keyless URL connection
      // is impossible, so keep the top level as-is; those aliases still
      // resolve via modelConnection's top-level fallback.
      for (const entry of Object.values(models ?? {})) {
        if ((entry as RawModelEntry).provider === '') {
          (entry as RawModelEntry).provider = undefined;
          if (parsed.apiKey) (entry as RawModelEntry).apiKey = parsed.apiKey;
          if (parsed.backend) (entry as RawModelEntry).backend = parsed.backend;
        }
      }
    }
  }

  // Drop the placeholder marker if it never got a real connection.
  if (models) {
    for (const entry of Object.values(models)) {
      if ((entry as RawModelEntry).provider === '') (entry as RawModelEntry).provider = undefined;
    }
  }

  parsed.providers = Object.keys(providers).length ? providers : undefined;
  // `model` may name an alias with a legacy endpoint; keep it as-is —
  // modelConnection resolves both shapes.
}

function parseConfig(raw: string): AgentConfig {
  const parsed = JSON.parse(raw) as AgentConfig;
  // roleModels belonged to the retired hard-coded Reception/Brain/Worker
  // architecture. Agent-specific model selection now lives in Agent Specs.
  delete (parsed as AgentConfig & { roleModels?: unknown }).roleModels;
  if (parsed.backend && !BACKENDS.includes(parsed.backend)) {
    throw new Error(`Invalid backend "${parsed.backend}" in config. Use "openai", "anthropic", or "ollama".`);
  }
  if (parsed.artifactsDir !== undefined && typeof parsed.artifactsDir !== 'string') {
    throw new Error('Invalid artifactsDir in config. Use a string path.');
  }
  if (parsed.providers) {
    for (const [name, provider] of Object.entries(parsed.providers)) {
      parsed.providers![name] = parseProviderEntry(name, provider);
    }
  }
  if (parsed.models) {
    for (const [name, modelConfig] of Object.entries(parsed.models)) {
      if (modelConfig.wireApi && !['chat', 'responses'].includes(modelConfig.wireApi)) {
        throw new Error(`Invalid wireApi for model alias "${name}". Use "chat" or "responses".`);
      }
      if (!modelConfig?.model || typeof modelConfig.model !== 'string') {
        throw new Error(`Invalid model alias "${name}" in config. Each model alias needs a string "model".`);
      }
      if (modelConfig.backend && !BACKENDS.includes(modelConfig.backend)) {
        throw new Error(`Invalid backend "${modelConfig.backend}" for model alias "${name}". Use "openai", "anthropic", or "ollama".`);
      }
    }
  }
  migrateLegacyModels(parsed);
  return parsed;
}

async function tryReadConfigWithPath(dir: string): Promise<LoadedConfig | null> {
  for (const name of CONFIG_FILES) {
    const path = join(dir, name);
    try {
      const raw = await readFile(path, 'utf8');
      return { config: parseConfig(raw), path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not load config ${path}: ${message}`);
      }
    }
  }
  return null;
}

/**
 * Async config loader — call once at startup.
 * CWD config takes precedence over home directory config.
 */
export async function loadConfig(): Promise<AgentConfig> {
  const loaded = await loadConfigWithPath();
  return loaded.config;
}

export async function loadConfigWithPath(): Promise<LoadedConfig> {
  const userDir = configHome();
  const sameDir = resolve(process.cwd()).toLowerCase() === resolve(userDir).toLowerCase();
  const projectConfig = sameDir ? null : await tryReadConfigWithPath(process.cwd());
  const userConfig = await tryReadConfigWithPath(userDir);
  return {
    config: mergeConfig(projectConfig?.config ?? {}, userConfig?.config ?? {}),
    path: userConfig?.path ?? join(userDir, '.agentrc'),
  };
}

export async function saveSelectedModel(model: string): Promise<string> {
  const loaded = await loadConfigWithPath();
  const nextConfig: AgentConfig = {
    ...loaded.config,
    model,
  };

  return saveConfig(nextConfig, loaded.path);
}

export async function saveConfig(config: AgentConfig, existingPath?: string): Promise<string> {
  const path = existingPath ?? join(configHome(), '.agentrc');
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  const previous = configWrites.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, payload, 'utf8');
      await replaceConfigFile(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
  configWrites.set(path, next);
  try {
    await next;
  } finally {
    if (configWrites.get(path) === next) configWrites.delete(path);
  }
  return path;
}
