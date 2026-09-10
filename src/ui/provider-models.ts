/**
 * provider-models.ts — /provider and /model flows for the fullscreen TUI.
 *
 * Two configuration layers:
 *   providers — named connections (baseUrl + apiKey + optional backend),
 *               stored once so the API key is never duplicated;
 *   models    — aliases that reference a provider plus the provider-side
 *               model id (plus per-alias knobs like contextWindow).
 *
 * The /provider modal is two-level: the first list manages providers, and
 * opening one manages that provider's models — add (from the endpoint's own
 * model list, reusing the saved connection), switch to, or remove. Nothing
 * ever re-asks for a base URL or key that a saved provider already has.
 */

import { resilientFetch } from '../fetch.js';
import type { AgentConfig, AgentModelConfig, AgentProviderConfig } from '../config.js';

export type ProviderBackend = 'ollama' | 'openai' | 'anthropic';

export interface ProviderPreset {
  id: string;
  label: string;
  backend: ProviderBackend;
  baseUrl: string;
  needsKey: boolean;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', backend: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { id: 'openrouter', label: 'OpenRouter', backend: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true },
  { id: 'anthropic', label: 'Anthropic', backend: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true },
  { id: 'opencode-go', label: 'OpenCode Go', backend: 'openai', baseUrl: 'https://opencode.ai/zen/go/v1', needsKey: true },
  { id: 'ollama', label: 'Ollama · local', backend: 'ollama', baseUrl: 'http://localhost:11434', needsKey: false },
  { id: 'custom', label: 'Custom · OpenAI compatible', backend: 'openai', baseUrl: '', needsKey: false },
];

/** Human name for a stored connection, from backend or URL host. */
export function providerLabel(provider: AgentProviderConfig): string {
  if (provider.backend === 'anthropic') return 'Anthropic';
  if (provider.backend === 'ollama') return 'Ollama';
  if (provider.baseUrl.includes('openrouter.ai')) return 'OpenRouter';
  if (provider.baseUrl.includes('opencode.ai/zen')) return 'OpenCode Go';
  return 'OpenAI compatible';
}

/** Human name for the connection a model entry routes through. */
export function modelProviderLabel(config: AgentConfig, entry: AgentModelConfig): string {
  const provider = entry.provider !== undefined ? config.providers?.[entry.provider] : undefined;
  if (provider) return providerLabel(provider);
  if (entry.backend === 'anthropic') return 'Anthropic';
  if (entry.backend === 'ollama') return 'Ollama';
  if (entry.baseUrl?.includes('openrouter.ai')) return 'OpenRouter';
  if (entry.baseUrl?.includes('opencode.ai/zen')) return 'OpenCode Go';
  return 'OpenAI compatible';
}

async function fetchRemoteModels(baseUrl: string, apiKey: string | undefined, backend: ProviderBackend | undefined): Promise<{ models: string[]; error?: string }> {
  try {
    const trimmed = baseUrl.replace(/\/+$/, '');
    const url = backend === 'anthropic' ? `${trimmed}/v1/models` : backend === 'ollama' ? `${trimmed}/v1/models` : `${trimmed}/models`;
    const headers: Record<string, string> = backend === 'anthropic'
      ? { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' }
      : apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const response = await resilientFetch(url, { headers, retries: 0, timeout: 15000 });
    const body = await response.json() as { data?: Array<{ id?: string }> };
    return { models: [...new Set((body.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id)))].sort() };
  } catch (error) {
    return { models: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** Short connection name guessed from the endpoint host (localhost → "localhost"). */
function suggestConnectionName(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.').filter((part) => part && !['com', 'ai', 'org', 'net', 'dev'].includes(part));
    const name = (parts[parts.length - 1] ?? host).replace(/[^a-z0-9-]/gi, '').toLowerCase();
    return name || 'provider';
  } catch {
    return 'provider';
  }
}

function uniqueConnectionName(config: AgentConfig, base: string): string {
  let name = base;
  for (let n = 2; config.providers?.[name]; n += 1) name = `${base}-${n}`;
  return name;
}

export interface ProviderModelDeps {
  configManager: { getConfig: () => AgentConfig; saveConfig: (config: AgentConfig) => Promise<void> };
  choose: (title: string, items: readonly (string | { label: string; detail?: string })[], options?: { searchable?: boolean; initial?: number }) => Promise<number>;
  ask: (label: string, initial?: string, secret?: boolean) => Promise<string>;
  notify: (message: string) => void;
  applyModel: (alias: string) => Promise<void>;
  activeModel: () => string;
  modelAliases?: readonly string[];
}

export function createProviderFlows(deps: ProviderModelDeps): { openProvider: () => Promise<void>; openModel: () => Promise<void> } {
  const modelsOf = (config: AgentConfig, name: string): Array<[string, AgentModelConfig]> =>
    Object.entries(config.models ?? {}).filter(([, entry]) => entry.provider === name);

  const commitModel = async (name: string, modelId: string): Promise<void> => {
    const config = deps.configManager.getConfig();
    if (!config.providers?.[name]) return;
    const suggested = modelId.includes('/') ? modelId.split('/').pop()! : modelId.split(':')[0]!;
    const alias = await deps.ask('Local alias', suggested);
    if (!alias) return;
    if (config.models?.[alias]) {
      const replace = await deps.choose(`Replace ${alias}?`, ['Replace', 'Cancel']);
      if (replace !== 0) return;
    }
    const contextRaw = await deps.ask('Context window · optional');
    const contextWindow = Number.parseInt(contextRaw, 10);
    await deps.configManager.saveConfig({
      ...config,
      model: config.model || alias,
      models: {
        ...(config.models ?? {}),
        [alias]: {
          provider: name,
          model: modelId,
          ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
        },
      },
    });
    deps.notify(`Added model ${alias}.`);
    if (!config.model) await deps.applyModel(alias);
  };

  /** Repeatedly offers a model list; Escape (negative index) stops adding. */
  const addModelsFromList = async (name: string, remoteModels: string[]): Promise<void> => {
    for (;;) {
      const index = await deps.choose('Provider model', [...remoteModels, 'Type manually…'], { searchable: true });
      if (index < 0) return;
      const modelId = index < remoteModels.length ? remoteModels[index]! : await deps.ask('Provider model name');
      if (!modelId) continue;
      await commitModel(name, modelId);
    }
  };

  /** Adds models to a saved provider, reusing its stored connection. */
  const addModelTo = async (name: string): Promise<void> => {
    const config = deps.configManager.getConfig();
    const provider = config.providers?.[name];
    if (!provider) return;
    const remote = await fetchRemoteModels(provider.baseUrl, provider.apiKey, provider.backend);
    if (remote.error) deps.notify('Could not load models. Enter a model name manually.');
    if (!remote.models.length) {
      const manual = await deps.ask('Provider model name');
      if (manual) await commitModel(name, manual);
      return;
    }
    await addModelsFromList(name, remote.models);
  };

  const removeModelFrom = async (name: string): Promise<void> => {
    const config = deps.configManager.getConfig();
    const models = modelsOf(config, name);
    if (!models.length) return;
    const index = await deps.choose('Remove model', models.map(([alias, entry]) => ({ label: alias, detail: entry.model })));
    if (index < 0) return;
    const [alias] = models[index]!;
    const confirm = await deps.choose(`Remove ${alias}?`, ['Remove', 'Cancel']);
    if (confirm !== 0) return;
    const nextModels = { ...(config.models ?? {}) };
    delete nextModels[alias];
    const model = config.model === alias ? Object.keys(nextModels)[0] : config.model;
    await deps.configManager.saveConfig({ ...config, model, models: nextModels });
    if (deps.activeModel() === alias && model) await deps.applyModel(model);
    deps.notify(`Removed model ${alias}.`);
  };

  /** Second level: manage one saved provider's models. */
  const openProviderModels = async (name: string): Promise<void> => {
    for (;;) {
      const config = deps.configManager.getConfig();
      const provider = config.providers?.[name];
      if (!provider) return;
      const models = modelsOf(config, name);
      const active = deps.activeModel();
      const actions: Array<{ action: 'model' | 'add' | 'remove' | 'back'; alias: string }> = [
        ...models.map(([alias]) => ({ action: 'model' as const, alias })),
        { action: 'add', alias: '' },
        ...(models.length ? [{ action: 'remove' as const, alias: '' }] : []),
        { action: 'back', alias: '' },
      ];
      const items = actions.map((item) => {
        if (item.action === 'add') return { label: 'Add model', detail: 'Fetch the model list from the saved endpoint' };
        if (item.action === 'remove') return { label: 'Remove model', detail: 'Delete one of these aliases' };
        if (item.action === 'back') return { label: 'Back', detail: 'Return to the provider list' };
        const entry = config.models?.[item.alias]!;
        return {
          label: `${item.alias}${item.alias === active ? '  ✓' : ''}`,
          detail: entry.model === item.alias ? entry.model : `${entry.model}  ·  alias ${item.alias}`,
        };
      });
      const index = await deps.choose(`Provider · ${name}`, items);
      if (index < 0) return;
      const selected = actions[index]!;
      if (selected.action === 'model') await deps.applyModel(selected.alias);
      else if (selected.action === 'add') await addModelTo(name);
      else if (selected.action === 'remove') await removeModelFrom(name);
      else return;
    }
  };

  /** First level: manage connections, then descend into one. */
  const openProvider = async (): Promise<void> => {
    for (;;) {
      const config = deps.configManager.getConfig();
      const entries = Object.entries(config.providers ?? {});
      const actions: Array<{ action: 'open' | 'add' | 'remove'; name: string }> = [
        ...entries.map(([name]) => ({ action: 'open' as const, name })),
        { action: 'add', name: '' },
        ...(entries.length ? [{ action: 'remove' as const, name: '' }] : []),
      ];
      const items = actions.map((item) => {
        if (item.action === 'add') return { label: 'Add provider', detail: 'Configure a model endpoint' };
        if (item.action === 'remove') return { label: 'Remove provider', detail: 'Delete a configured endpoint' };
        const count = modelsOf(config, item.name).length;
        return {
          label: item.name,
          detail: `${providerLabel(config.providers![item.name]!)} · ${count ? `${count} model${count === 1 ? '' : 's'}` : 'no models'}`,
        };
      });
      const index = await deps.choose('Provider', items);
      if (index < 0) return;
      const selected = actions[index]!;
      if (selected.action === 'open') await openProviderModels(selected.name);
      else if (selected.action === 'add') await addProvider();
      else await removeProvider();
    }
  };

  /** Stores a connection once; models are attached afterwards, reusing it. */
  const addProvider = async (): Promise<void> => {
    const providerIndex = await deps.choose('Add provider', PROVIDER_PRESETS.map((preset) => preset.label));
    if (providerIndex < 0) return;
    const preset = PROVIDER_PRESETS[providerIndex]!;
    const baseUrl = await deps.ask('Base URL', preset.baseUrl);
    if (!baseUrl) return;
    let apiKey: string | undefined;
    if (preset.needsKey) {
      const envName = preset.id === 'openrouter' ? 'OPENROUTER_API_KEY'
        : preset.id === 'anthropic' ? 'ANTHROPIC_API_KEY'
        : preset.id === 'opencode-go' ? 'OPENCODE_API_KEY'
        : 'OPENAI_API_KEY';
      apiKey = await deps.ask(`API key · blank uses ${envName}`, '', true) || process.env[envName];
      if (!apiKey) return;
    } else if (preset.id === 'custom') {
      apiKey = await deps.ask('API key · optional', '', true) || undefined;
    }
    const remote = await fetchRemoteModels(baseUrl, apiKey, preset.backend);
    if (remote.error) deps.notify('Could not load models. Enter a model name manually.');
    const config = deps.configManager.getConfig();
    const name = uniqueConnectionName(config, suggestConnectionName(baseUrl));
    await deps.configManager.saveConfig({
      ...config,
      providers: {
        ...(config.providers ?? {}),
        [name]: { baseUrl, ...(apiKey ? { apiKey } : {}), ...(preset.id === 'custom' ? {} : { backend: preset.backend }) },
      },
    });
    deps.notify(`Saved provider ${name}. Open it to add models.`);
    if (remote.models.length) await addModelsFromList(name, remote.models);
  };

  const removeProvider = async (): Promise<void> => {
    const config = deps.configManager.getConfig();
    const entries = Object.entries(config.providers ?? {});
    if (!entries.length) return;
    const index = await deps.choose('Remove provider', entries.map(([name, provider]) => {
      const count = modelsOf(config, name).length;
      return {
        label: name,
        detail: `${providerLabel(provider)} · ${count ? `${count} model${count === 1 ? '' : 's'}` : 'no models'}`,
      };
    }));
    if (index < 0) return;
    const [name] = entries[index]!;
    const confirm = await deps.choose(`Remove ${name}?`, ['Remove provider and its models', 'Cancel']);
    if (confirm !== 0) return;
    const models = { ...(config.models ?? {}) };
    const removed: string[] = [];
    for (const [alias, entry] of Object.entries(models)) {
      if (entry.provider === name) { delete models[alias]; removed.push(alias); }
    }
    const providers = { ...(config.providers ?? {}) };
    delete providers[name];
    const model = removed.includes(config.model ?? '') ? Object.keys(models)[0] : config.model;
    await deps.configManager.saveConfig({ ...config, model, providers, models });
    const active = deps.activeModel();
    if (removed.includes(active) && model) await deps.applyModel(model);
    deps.notify(`Removed provider ${name}.`);
  };

  /** Quick switcher across every configured alias (also /model). */
  const openModel = async (): Promise<void> => {
    const config = deps.configManager.getConfig();
    const aliases = [...new Set([...(config.model ? [config.model] : []), ...Object.keys(config.models ?? {}), ...(deps.modelAliases ?? [])])];
    if (!aliases.length) { await openProvider(); return; }
    const index = await deps.choose('Model', aliases.map((alias) => {
      const entry = config.models?.[alias];
      return {
        label: `${alias}${alias === deps.activeModel() ? '  ✓' : ''}`,
        detail: entry ? `${modelProviderLabel(config, entry)} · ${entry.model}` : 'Session model',
      };
    }), { searchable: true });
    if (index >= 0) await deps.applyModel(aliases[index]!);
  };

  return { openProvider, openModel };
}
