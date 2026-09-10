import { detectBackend, type BackendConfig, type BackendType } from './backend.js';
import { modelConnection, type AgentConfig, type AgentModelConfig } from './config.js';

export type ResolvedModel = {
  name: string;
  config: BackendConfig;
};

export function defaultBaseUrlForBackend(backend: BackendType): string {
  if (backend === 'anthropic') return 'https://api.anthropic.com';
  if (backend === 'openai') return 'https://api.openai.com/v1';
  return 'http://localhost:11434';
}

export function resolveModelConfig(fileConfig: AgentConfig, requestedModel?: string): ResolvedModel {
  const defaultModel = requestedModel ?? process.env.AGENT_MODEL ?? fileConfig.model;
  if (!defaultModel) {
    return {
      name: '(unconfigured)',
      config: {
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        model: '',
      },
    };
  }
  const aliasConfig = fileConfig.models?.[defaultModel];
  const modelConfig: AgentModelConfig = aliasConfig ?? { model: defaultModel };
  const connection = modelConnection(fileConfig, modelConfig);
  const requestedBackend = (process.env.LLM_BACKEND
    ?? connection?.backend) as BackendType | undefined;
  const baseUrl = process.env.LLM_BASE_URL
    ?? process.env.OLLAMA_BASE_URL
    ?? connection?.baseUrl
    ?? (requestedBackend ? defaultBaseUrlForBackend(requestedBackend) : undefined);
  if (!baseUrl) {
    throw new Error('No base URL specified. Set "baseUrl" in .agentrc or set LLM_BASE_URL env var.');
  }
  const backend = (requestedBackend ?? detectBackend(baseUrl)) as BackendType;
  const apiKey = process.env.LLM_API_KEY ?? connection?.apiKey;

  return {
    name: aliasConfig ? defaultModel : modelConfig.model,
    config: {
      type: backend,
      baseUrl,
      model: modelConfig.model,
      ...(modelConfig.wireApi ? { wireApi: modelConfig.wireApi } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(modelConfig.requestOptions ? { requestOptions: modelConfig.requestOptions } : {}),
      ...(modelConfig.contextWindow ? { contextWindow: modelConfig.contextWindow } : {}),
    },
  };
}
