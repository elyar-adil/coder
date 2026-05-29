/**
 * config.ts — .agentrc config file support.
 *
 * Looks for .agentrc in:
 *  1. Current working directory
 *  2. User home directory (~/.agentrc)
 *
 * Format: JSON with optional fields:
 *  {
 *    "baseUrl": "http://localhost:11434",
 *    "model": "gemma4:31b-cloud",
 *    "backend": "openai",
 *    "apiKey": "sk-...",
 *    "defaultMode": "build",
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

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { BackendType } from './backend.js';

export interface AgentConfig {
  baseUrl?: string;
  model?: string;
  backend?: BackendType;
  apiKey?: string;
  defaultMode?: 'build' | 'plan';
  policyLevel?: 'strict' | 'moderate' | 'off';
  artifactsDir?: string;
  models?: Record<string, AgentModelConfig>;
}

export interface AgentModelConfig {
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

export interface LoadedConfig {
  config: AgentConfig;
  path?: string;
}

function parseConfig(raw: string): AgentConfig {
  const parsed = JSON.parse(raw) as AgentConfig & { defaultMode?: string };
  if (parsed.backend && !['ollama', 'openai', 'anthropic'].includes(parsed.backend)) {
    throw new Error(`Invalid backend "${parsed.backend}" in config. Use "openai", "anthropic", or "ollama".`);
  }
  if (parsed.defaultMode && !['build', 'plan', 'execute', 'react'].includes(parsed.defaultMode)) {
    throw new Error(`Invalid defaultMode "${parsed.defaultMode}" in config. Use "build" or "plan".`);
  }
  if (parsed.defaultMode && parsed.defaultMode !== 'build' && parsed.defaultMode !== 'plan') {
    parsed.defaultMode = parsed.defaultMode === 'plan' ? 'plan' : 'build';
  }
  if (parsed.artifactsDir !== undefined && typeof parsed.artifactsDir !== 'string') {
    throw new Error('Invalid artifactsDir in config. Use a string path.');
  }
  if (parsed.models) {
    for (const [name, modelConfig] of Object.entries(parsed.models)) {
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
    } catch {
      // not found
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
  const cwdConfig = await tryReadConfigWithPath(process.cwd());
  if (cwdConfig) return cwdConfig;

  const homeConfig = await tryReadConfigWithPath(homedir());
  if (homeConfig) return homeConfig;

  return { config: {} };
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
  const path = existingPath ?? (await loadConfigWithPath()).path ?? join(process.cwd(), '.agentrc');
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return path;
}
