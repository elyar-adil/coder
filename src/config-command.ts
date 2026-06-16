import * as readline from 'readline';
import { loadConfig, saveConfig, type AgentConfig, type AgentModelConfig } from './config.js';

type Provider = 'ollama' | 'openrouter' | 'anthropic' | 'openai' | 'custom';

interface ProviderInfo {
  name: string;
  description: string;
  defaultBaseUrl: string;
  needsApiKey: boolean;
  canListModels: boolean;
}

const PROVIDERS: Record<Provider, ProviderInfo> = {
  ollama: {
    name: 'Ollama (Local)',
    description: 'Run models locally via Ollama',
    defaultBaseUrl: 'http://localhost:11434',
    needsApiKey: false,
    canListModels: true,
  },
  openrouter: {
    name: 'OpenRouter',
    description: 'Access 200+ models via openrouter.ai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    needsApiKey: true,
    canListModels: true,
  },
  anthropic: {
    name: 'Anthropic (Claude)',
    description: 'Claude models via api.anthropic.com',
    defaultBaseUrl: 'https://api.anthropic.com',
    needsApiKey: true,
    canListModels: false,
  },
  openai: {
    name: 'OpenAI (GPT)',
    description: 'GPT models via api.openai.com',
    defaultBaseUrl: 'https://api.openai.com/v1',
    needsApiKey: true,
    canListModels: true,
  },
  custom: {
    name: 'Custom / Other',
    description: 'Any OpenAI-compatible endpoint (LM Studio, vLLM, etc.)',
    defaultBaseUrl: '',
    needsApiKey: false,
    canListModels: false,
  },
};

function createPrompt(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

function askChoice(rl: readline.Interface, question: string, choices: string[]): Promise<string> {
  return new Promise((resolve) => {
    const display = choices.map((c, i) => `  ${i + 1}) ${c}`).join('\n');
    rl.question(`${question}\n${display}\n> `, (answer) => {
      const idx = parseInt(answer, 10) - 1;
      if (idx >= 0 && idx < choices.length) {
        resolve(choices[idx]);
      } else {
        resolve(answer.trim());
      }
    });
  });
}

async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json() as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

async function fetchOpenRouterModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const data = await res.json() as { data?: Array<{ id: string; name?: string }> };
    return (data.data ?? []).map((m) => m.id).sort();
  } catch {
    return [];
  }
}

async function fetchOpenAIModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const data = await res.json() as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((m) => m.id).filter((id) => id.startsWith('gpt-')).sort();
  } catch {
    return [];
  }
}

function pickFromList(models: string[], hint?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createPrompt();
    if (models.length === 0) {
      rl.question('No models found. Enter model name manually: ', (answer) => {
        rl.close();
        resolve(answer.trim() || null);
      });
      return;
    }

    const display = models.slice(0, 50).map((m, i) => `  ${i + 1}) ${m}`).join('\n');
    const suffix = models.length > 50 ? `\n  ... and ${models.length - 50} more` : '';
    rl.question(
      `${hint ?? 'Select a model:'}\n${display}${suffix}\n  0) Enter manually\n> `,
      (answer) => {
        rl.close();
        const idx = parseInt(answer, 10) - 1;
        if (idx >= 0 && idx < models.length) {
          resolve(models[idx]);
        } else if (answer.trim() === '0' || isNaN(idx)) {
          rl.question('Enter model name: ', (manual) => {
            resolve(manual.trim() || null);
          });
        } else {
          resolve(null);
        }
      },
    );
  });
}

function filterModels(models: string[], query: string): string[] {
  if (!query) return models;
  const lower = query.toLowerCase();
  return models.filter((m) => m.toLowerCase().includes(lower));
}

async function configureProvider(
  provider: Provider,
  existingConfig: AgentConfig,
): Promise<{ modelConfig: AgentModelConfig; alias: string } | null> {
  const info = PROVIDERS[provider];
  const rl = createPrompt();

  try {
    // Base URL
    let baseUrl = info.defaultBaseUrl;
    if (provider === 'custom') {
      const input = await ask(rl, `Base URL (e.g. http://localhost:1234/v1): `);
      if (!input) { console.log('Cancelled.'); return null; }
      baseUrl = input;
    } else if (provider === 'ollama') {
      const input = await ask(rl, `Ollama URL [${baseUrl}]: `);
      if (input) baseUrl = input;
    }

    // API Key
    let apiKey: string | undefined;
    if (info.needsApiKey) {
      const envKey = provider === 'openrouter' ? 'OPENROUTER_API_KEY'
        : provider === 'anthropic' ? 'ANTHROPIC_API_KEY'
        : provider === 'openai' ? 'OPENAI_API_KEY'
        : undefined;
      const envVal = envKey ? process.env[envKey] : undefined;
      const hint = envVal ? ` (detected from ${envKey})` : '';
      const input = await ask(rl, `API Key${hint}: `);
      apiKey = input || envVal;
      if (!apiKey) { console.log('API key required. Cancelled.'); return null; }
    }

    // Fetch models
    let models: string[] = [];
    if (info.canListModels) {
      console.log('Fetching available models...');
      if (provider === 'ollama') {
        models = await fetchOllamaModels(baseUrl);
      } else if (provider === 'openrouter') {
        models = await fetchOpenRouterModels(apiKey!);
      } else if (provider === 'openai') {
        models = await fetchOpenAIModels(apiKey!);
      }

      if (models.length > 0) {
        console.log(`Found ${models.length} models.`);
      }
    }

    // Model selection
    let selectedModel: string | null = null;
    if (models.length > 0) {
      // For OpenRouter, let user filter
      if (provider === 'openrouter' && models.length > 20) {
        const filter = await ask(rl, 'Filter models (e.g. "claude", "gpt-4", "deepseek"): ');
        const filtered = filterModels(models, filter);
        if (filtered.length > 0) {
          selectedModel = await pickFromList(filtered, `Select a model (${filtered.length} matches):`);
        } else {
          selectedModel = await pickFromList(models, 'No matches. All models:');
        }
      } else {
        selectedModel = await pickFromList(models);
      }
    } else {
      const input = await ask(rl, 'Model name (e.g. llama3, claude-3-opus, gpt-4): ');
      selectedModel = input || null;
    }

    if (!selectedModel) { console.log('No model selected. Cancelled.'); return null; }

    // Alias name
    const defaultAlias = provider === 'ollama' ? selectedModel.split(':')[0]
      : provider === 'openrouter' ? selectedModel.split('/').pop() ?? selectedModel
      : selectedModel;
    const alias = await ask(rl, `Alias name [${defaultAlias}]: `);

    // Context window
    const ctxInput = await ask(rl, 'Context window size (leave blank for default): ');
    const contextWindow = ctxInput ? parseInt(ctxInput, 10) : undefined;

    const modelConfig: AgentModelConfig = {
      model: selectedModel,
      baseUrl,
      backend: provider === 'ollama' ? 'ollama' : provider === 'anthropic' ? 'anthropic' : 'openai',
      ...(apiKey ? { apiKey } : {}),
      ...(contextWindow && !isNaN(contextWindow) ? { contextWindow } : {}),
    };

    return { modelConfig, alias: alias || defaultAlias };
  } finally {
    rl.close();
  }
}

export async function runConfigCommand(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║     Model Configuration Wizard           ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const existingConfig = await loadConfig();
  const rl = createPrompt();

  try {
    const action = await askChoice(rl, 'What would you like to do?', [
      'Add a new model',
      'Set default model',
      'List configured models',
      'Remove a model',
      'Exit',
    ]);

    switch (action) {
      case 'Add a new model': {
        const providerKey = await askChoice(rl, '\nSelect a provider:', [
          PROVIDERS.ollama.name,
          PROVIDERS.openrouter.name,
          PROVIDERS.anthropic.name,
          PROVIDERS.openai.name,
          PROVIDERS.custom.name,
        ]);

        const providerMap: Record<string, Provider> = {
          [PROVIDERS.ollama.name]: 'ollama',
          [PROVIDERS.openrouter.name]: 'openrouter',
          [PROVIDERS.anthropic.name]: 'anthropic',
          [PROVIDERS.openai.name]: 'openai',
          [PROVIDERS.custom.name]: 'custom',
        };
        const provider = providerMap[providerKey] ?? 'custom';

        const result = await configureProvider(provider, existingConfig);
        if (!result) break;

        const models = existingConfig.models ?? {};
        models[result.alias] = result.modelConfig;
        existingConfig.models = models;

        // If this is the first model, set it as default
        if (!existingConfig.model) {
          existingConfig.model = result.alias;
        }

        await saveConfig(existingConfig);
        console.log(`\n✓ Model "${result.alias}" added (${result.modelConfig.model})`);
        console.log(`  Provider: ${PROVIDERS[provider].name}`);
        console.log(`  Base URL: ${result.modelConfig.baseUrl}`);
        if (existingConfig.model === result.alias) {
          console.log('  Set as default model.');
        }
        break;
      }

      case 'Set default model': {
        const models = existingConfig.models ?? {};
        const keys = Object.keys(models);
        if (keys.length === 0) {
          console.log('\nNo models configured yet. Add one first.');
          break;
        }
        const choice = await askChoice(rl, '\nSelect default model:', keys);
        if (keys.includes(choice)) {
          existingConfig.model = choice;
          await saveConfig(existingConfig);
          console.log(`\n✓ Default model set to "${choice}"`);
        }
        break;
      }

      case 'List configured models': {
        const models = existingConfig.models ?? {};
        const keys = Object.keys(models);
        if (keys.length === 0) {
          console.log('\nNo models configured. Run `coder config` to add one.');
          break;
        }
        console.log('\nConfigured models:');
        for (const key of keys) {
          const m = models[key];
          const marker = key === existingConfig.model ? ' (DEFAULT)' : '';
          console.log(`  ${key}${marker}`);
          console.log(`    model: ${m.model}`);
          console.log(`    backend: ${m.backend ?? 'auto'}`);
          console.log(`    baseUrl: ${m.baseUrl ?? 'default'}`);
          if (m.contextWindow) console.log(`    context: ${m.contextWindow}`);
        }
        break;
      }

      case 'Remove a model': {
        const models = existingConfig.models ?? {};
        const keys = Object.keys(models);
        if (keys.length === 0) {
          console.log('\nNo models to remove.');
          break;
        }
        const choice = await askChoice(rl, '\nSelect model to remove:', keys);
        if (keys.includes(choice)) {
          delete models[choice];
          existingConfig.models = models;
          if (existingConfig.model === choice) {
            existingConfig.model = keys[0] !== choice ? keys[0] : undefined;
          }
          await saveConfig(existingConfig);
          console.log(`\n✓ Model "${choice}" removed.`);
        }
        break;
      }

      default:
        console.log('Exiting.');
        break;
    }
  } finally {
    rl.close();
  }
}
