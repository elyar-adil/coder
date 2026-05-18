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
 *    "backend": "ollama",
 *    "apiKey": "sk-...",
 *    "defaultMode": "execute"
 *  }
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { BackendType } from './backend.js';

export interface AgentConfig {
  baseUrl?: string;
  model?: string;
  backend?: BackendType;
  apiKey?: string;
  defaultMode?: 'execute' | 'plan' | 'react';
  policyLevel?: 'strict' | 'moderate' | 'off';
}

const CONFIG_FILES = ['.agentrc', '.agentrc.json'];

function parseConfig(raw: string): AgentConfig {
  const parsed = JSON.parse(raw) as AgentConfig;
  if (parsed.backend && !['ollama', 'openai'].includes(parsed.backend)) {
    throw new Error(`Invalid backend "${parsed.backend}" in config. Use "ollama" or "openai".`);
  }
  if (parsed.defaultMode && !['execute', 'plan', 'react'].includes(parsed.defaultMode)) {
    throw new Error(`Invalid defaultMode "${parsed.defaultMode}" in config. Use "execute", "plan", or "react".`);
  }
  return parsed;
}

async function tryReadConfig(dir: string): Promise<AgentConfig | null> {
  for (const name of CONFIG_FILES) {
    try {
      const raw = await readFile(join(dir, name), 'utf8');
      return parseConfig(raw);
    } catch { /* not found */ }
  }
  return null;
}

/**
 * Async config loader — call once at startup.
 * CWD config takes precedence over home directory config.
 */
export async function loadConfig(): Promise<AgentConfig> {
  const cwdConfig = await tryReadConfig(process.cwd());
  if (cwdConfig) return cwdConfig;

  const homeConfig = await tryReadConfig(homedir());
  if (homeConfig) return homeConfig;

  return {};
}
