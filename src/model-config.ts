import { detectBackend, type BackendConfig, type BackendType } from './backend.js';
import type { AgentConfig, AgentModelConfig } from './config.js';

export type ResolvedModel = {
  name: string;
  config: BackendConfig;
};

export function defaultBaseUrlForBackend(backend: BackendType): string {
  if (backend === 'anthropic') return 'https://api.anthropic.com';
  if (backend === 'openai') return 'https://api.openai.com';
  return 'http://localhost:11434';
}

export function resolveModelConfig(fileConfig: AgentConfig, requestedModel?: string): ResolvedModel {
  const defaultModel = requestedModel ?? process.env.AGENT_MODEL ?? fileConfig.model;
  if (!defaultModel) {
    throw new Error('No model specified. Set "model" in .agentrc, use --model, or set AGENT_MODEL env var.');
  }
  const aliasConfig = fileConfig.models?.[defaultModel];
  const modelConfig: AgentModelConfig = aliasConfig ?? { model: defaultModel };
  const requestedBackend = (process.env.LLM_BACKEND
    ?? modelConfig.backend
    ?? fileConfig.backend) as BackendType | undefined;
  const baseUrl = process.env.LLM_BASE_URL
    ?? process.env.OLLAMA_BASE_URL
    ?? modelConfig.baseUrl
    ?? fileConfig.baseUrl
    ?? (requestedBackend ? defaultBaseUrlForBackend(requestedBackend) : undefined);
  if (!baseUrl) {
    throw new Error('No base URL specified. Set "baseUrl" in .agentrc or set LLM_BASE_URL env var.');
  }
  const backend = (requestedBackend ?? detectBackend(baseUrl)) as BackendType;
  const apiKey = process.env.LLM_API_KEY ?? modelConfig.apiKey ?? fileConfig.apiKey;

  return {
    name: aliasConfig ? defaultModel : modelConfig.model,
    config: {
      type: backend,
      baseUrl,
      model: modelConfig.model,
      ...(apiKey ? { apiKey } : {}),
      ...(modelConfig.requestOptions ? { requestOptions: modelConfig.requestOptions } : {}),
      ...(modelConfig.contextWindow ? { contextWindow: modelConfig.contextWindow } : {}),
    },
  };
}
