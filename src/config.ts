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
 *    "models": {
 *      "fast": {
 *        "model": "provider-model-id",
 *        "requestOptions": {
 *          "extraBody": {
 *            "provider_option": true
 *          }
 *        }
 *      }
 *    }
 *  }
 */

import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { BackendType } from './backend.js';

export interface AgentConfig {
  baseUrl?: string;
  model?: string;
  backend?: BackendType;
  apiKey?: string;
  policyLevel?: 'strict' | 'moderate' | 'off';
  artifactsDir?: string;
  models?: Record<string, AgentModelConfig>;
}

export interface AgentModelConfig {
  wireApi?: 'chat' | 'responses';
  baseUrl?: string;
  model: string;
  backend?: BackendType;
  apiKey?: string;
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
    models: Object.keys(project.models ?? {}).length || Object.keys(user.models ?? {}).length
      ? { ...(project.models ?? {}), ...(user.models ?? {}) }
      : undefined,
  };
}

function parseConfig(raw: string): AgentConfig {
  const parsed = JSON.parse(raw) as AgentConfig;
  // roleModels belonged to the retired hard-coded Reception/Brain/Worker
  // architecture. Agent-specific model selection now lives in Agent Specs.
  delete (parsed as AgentConfig & { roleModels?: unknown }).roleModels;
  if (parsed.backend && !['ollama', 'openai', 'anthropic'].includes(parsed.backend)) {
    throw new Error(`Invalid backend "${parsed.backend}" in config. Use "openai", "anthropic", or "ollama".`);
  }
  if (parsed.artifactsDir !== undefined && typeof parsed.artifactsDir !== 'string') {
    throw new Error('Invalid artifactsDir in config. Use a string path.');
  }
  if (parsed.models) {
    for (const [name, modelConfig] of Object.entries(parsed.models)) {
      if (modelConfig.wireApi && !['chat', 'responses'].includes(modelConfig.wireApi)) {
        throw new Error(`Invalid wireApi for model alias "${name}". Use "chat" or "responses".`);
      }
      if (!modelConfig?.model || typeof modelConfig.model !== 'string') {
        throw new Error(`Invalid model alias "${name}" in config. Each model alias needs a string "model".`);
      }
      if (modelConfig.backend && !['ollama', 'openai', 'anthropic'].includes(modelConfig.backend)) {
        throw new Error(`Invalid backend "${modelConfig.backend}" for model alias "${name}". Use "openai", "anthropic", or "ollama".`);
      }
    }
  }
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
