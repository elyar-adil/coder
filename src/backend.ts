/**
 * backend.ts — LLM backend abstraction.
 *
 * Supports:
 *  • OpenAI-compatible chat completions over SSE
 *  • Anthropic Messages API over SSE
 *  • Local NDJSON chat endpoints used by some OpenAI-style runtimes
 *
 * The backend is selected via the LLM_BACKEND env var or .agentrc config.
 */

import { resilientFetch, FetchError } from './fetch.js';
import type { OllamaMsg } from './domain/task.js';
import type { OllamaToolDef } from './infra/tools.js';

export type BackendType = 'openai' | 'anthropic' | 'ollama';

export interface BackendConfig {
  type: BackendType;
  baseUrl: string;
  model: string;
  apiKey?: string;
  requestOptions?: {
    extraBody?: Record<string, unknown>;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
  };
  contextWindow?: number;
}

export interface ChatChunk {
  content: string | null;
  toolCalls?: OllamaMsg['tool_calls'];
  done: boolean;
}

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;

export function normalizeOpenAIBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function openAIChatCompletionsUrl(baseUrl: string): string {
  return `${normalizeOpenAIBaseUrl(baseUrl)}/v1/chat/completions`;
}

function parseNdjsonLine(line: string): { message?: OllamaMsg & { content: string | null }; done?: boolean } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as { message?: OllamaMsg & { content: string | null }; done?: boolean };
  } catch {
    return null;
  }
}

function normalizeToolArguments(args: Record<string, unknown> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    normalized[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return normalized;
}

function toolCallId(prefix = 'call'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

// ── Local NDJSON backend ────────────────────────────────────────────────────

async function* ollamaStream(
  config: BackendConfig,
  systemPrompt: string,
  messages: OllamaMsg[],
  tools?: OllamaToolDef[],
): AsyncGenerator<ChatChunk> {
  const body: Record<string, unknown> = {
    model: config.model,
    stream: true,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
  };
  if (tools?.length) body.tools = tools;

  const response = await resilientFetch(`${config.baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    retries: 2,
    timeout: 120_000,
  });

  if (!response.ok) throw new FetchError(`NDJSON backend HTTP ${response.status}`, response.status, false);
  if (!response.body) throw new Error('No response body from NDJSON backend');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const obj = parseNdjsonLine(line);
      if (!obj) continue;
      if (obj.message?.content) {
        yield { content: obj.message.content, done: false };
      }
      if (obj.message?.tool_calls?.length) {
        yield { content: null, toolCalls: obj.message.tool_calls, done: false };
      }
      if (obj.done) {
        yield { content: null, done: true };
        return;
      }
    }
  }
}

async function ollamaNonStream(
  config: BackendConfig,
  systemPrompt: string,
  messages: OllamaMsg[],
  tools?: OllamaToolDef[],
): Promise<ChatChunk> {
  const body: Record<string, unknown> = {
    model: config.model,
    stream: false,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
  };
  if (tools?.length) body.tools = tools;

  const response = await resilientFetch(`${config.baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    retries: 2,
    timeout: 120_000,
  });

  if (!response.ok) {
    throw new FetchError(`NDJSON backend HTTP ${response.status}: ${await response.text()}`, response.status, false);
  }
  const data = await response.json() as { message?: OllamaMsg & { content: string | null }; done?: boolean };
  return {
    content: data.message?.content ?? null,
    toolCalls: data.message?.tool_calls,
    done: true,
  };
}

// ── OpenAI-compatible chat completions ──────────────────────────────────────

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIChoice {
  delta?: {
    content?: string | null;
    tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
  };
  finish_reason?: string | null;
}

function convertToOpenAIMessages(systemPrompt: string, messages: OllamaMsg[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];
  for (const message of messages) {
    if (message.role === 'tool') {
      result.push({
        role: 'tool',
        content: message.content,
        ...(message.tool_use_id ? { tool_call_id: message.tool_use_id } : {}),
      });
      continue;
    }
    if (message.tool_calls?.length) {
      result.push({
        role: 'assistant',
        content: message.content,
        tool_calls: message.tool_calls.map((toolCall) => ({
          id: toolCall.id ?? toolCallId(),
          type: 'function' as const,
          function: {
            name: toolCall.function.name,
            arguments: JSON.stringify(toolCall.function.arguments),
          },
        })),
      });
      continue;
    }
    result.push({ role: message.role, content: message.content });
  }
  return result;
}

function convertToOllamaToolCalls(openaiCalls: OpenAIToolCall[]): OllamaMsg['tool_calls'] {
  return openaiCalls.map((toolCall) => {
    let args: Record<string, string> = {};
    try {
      args = JSON.parse(toolCall.function.arguments) as Record<string, string>;
    } catch {
      // Keep empty args if malformed.
    }
    return {
      id: toolCall.id,
      function: { name: toolCall.function.name, arguments: args },
    };
  });
}

function convertToolsToOpenAI(tools?: OllamaToolDef[]): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }));
}

function applyOpenAIRequestOptions(body: Record<string, unknown>, config: BackendConfig): void {
  const options = config.requestOptions;
  if (!options) return;
  if (typeof options.temperature === 'number') body.temperature = options.temperature;
  if (typeof options.topP === 'number') body.top_p = options.topP;
  if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens;
  if (options.extraBody) Object.assign(body, options.extraBody);
}

async function* openaiStream(
  config: BackendConfig,
  systemPrompt: string,
  messages: OllamaMsg[],
  tools?: OllamaToolDef[],
): AsyncGenerator<ChatChunk> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers['authorization'] = `Bearer ${config.apiKey}`;

  const body: Record<string, unknown> = {
    model: config.model,
    stream: true,
    messages: convertToOpenAIMessages(systemPrompt, messages),
  };
  applyOpenAIRequestOptions(body, config);
  const openaiTools = convertToolsToOpenAI(tools);
  if (openaiTools) body.tools = openaiTools;

  const response = await resilientFetch(openAIChatCompletionsUrl(config.baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    retries: 2,
    timeout: 120_000,
  });

  if (!response.ok) throw new FetchError(`OpenAI-compatible HTTP ${response.status}: ${await response.text()}`, response.status, false);
  if (!response.body) throw new Error('No response body from OpenAI-compatible backend');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pendingToolCalls = new Map<number, OpenAIToolCall>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') {
        if (trimmed === 'data: [DONE]' && pendingToolCalls.size > 0) {
          yield { content: null, toolCalls: convertToOllamaToolCalls([...pendingToolCalls.values()]), done: false };
          pendingToolCalls.clear();
        }
        if (trimmed === 'data: [DONE]') {
          yield { content: null, done: true };
          return;
        }
        continue;
      }
      if (!trimmed.startsWith('data: ')) continue;

      try {
        const parsed = JSON.parse(trimmed.slice(6)) as { choices?: OpenAIChoice[] };
        const choice = parsed.choices?.[0];
        if (!choice) continue;

        if (choice.delta?.content) {
          yield { content: choice.delta.content, done: false };
        }

        if (choice.delta?.tool_calls) {
          for (const toolCall of choice.delta.tool_calls) {
            if (toolCall.id) {
              pendingToolCalls.set(toolCall.index, {
                id: toolCall.id,
                type: 'function',
                function: {
                  name: toolCall.function?.name ?? '',
                  arguments: toolCall.function?.arguments ?? '',
                },
              });
            } else if (pendingToolCalls.has(toolCall.index)) {
              const existing = pendingToolCalls.get(toolCall.index)!;
              if (toolCall.function?.name) existing.function.name += toolCall.function.name;
              if (toolCall.function?.arguments) existing.function.arguments += toolCall.function.arguments;
            }
          }
        }

        if (choice.finish_reason === 'tool_calls' && pendingToolCalls.size > 0) {
          yield { content: null, toolCalls: convertToOllamaToolCalls([...pendingToolCalls.values()]), done: false };
          pendingToolCalls.clear();
        }

        if (choice.finish_reason === 'stop') {
          yield { content: null, done: true };
          return;
        }
      } catch {
        // Skip malformed SSE chunks.
      }
    }
  }
}

async function openaiNonStream(
  config: BackendConfig,
  systemPrompt: string,
  messages: OllamaMsg[],
  tools?: OllamaToolDef[],
): Promise<ChatChunk> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers['authorization'] = `Bearer ${config.apiKey}`;

  const body: Record<string, unknown> = {
    model: config.model,
    stream: false,
    messages: convertToOpenAIMessages(systemPrompt, messages),
  };
  applyOpenAIRequestOptions(body, config);
  const openaiTools = convertToolsToOpenAI(tools);
  if (openaiTools) body.tools = openaiTools;

  const response = await resilientFetch(openAIChatCompletionsUrl(config.baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    retries: 2,
    timeout: 120_000,
  });

  if (!response.ok) throw new FetchError(`OpenAI-compatible HTTP ${response.status}: ${await response.text()}`, response.status, false);
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }>;
  };

  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content ?? null,
    toolCalls: choice?.message?.tool_calls ? convertToOllamaToolCalls(choice.message.tool_calls) : undefined,
    done: true,
  };
}

// ── Anthropic Messages API ───────────────────────────────────────────────────

interface AnthropicToolCallState {
  id: string;
  name: string;
  inputText: string;
  initialInput?: Record<string, unknown>;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function convertToolsToAnthropic(tools?: OllamaToolDef[]): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

function convertToAnthropicMessages(messages: OllamaMsg[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.tool_use_id) {
        result.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: message.tool_use_id,
            content: message.content ?? '',
          }],
        });
      } else {
        result.push({ role: 'user', content: message.content ?? '' });
      }
      continue;
    }

    if (message.tool_calls?.length) {
      const content: Array<Record<string, unknown>> = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const toolCall of message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: toolCall.id ?? toolCallId('toolu'),
          name: toolCall.function.name,
          input: toolCall.function.arguments,
        });
      }
      result.push({ role: 'assistant', content });
      continue;
    }

    result.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content ?? '',
    });
  }
  return result;
}

function buildAnthropicHeaders(config: BackendConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (config.apiKey) headers['x-api-key'] = config.apiKey;
  return headers;
}

function anthropicToolStateToCall(state: AnthropicToolCallState): NonNullable<OllamaMsg['tool_calls']>[number] {
  let input: Record<string, string> = {};
  if (state.inputText.trim()) {
    try {
      input = normalizeToolArguments(JSON.parse(state.inputText) as Record<string, unknown>);
    } catch {
      input = normalizeToolArguments(state.initialInput);
    }
  } else {
    input = normalizeToolArguments(state.initialInput);
  }
  return {
    id: state.id,
    function: {
      name: state.name,
      arguments: input,
    },
  };
}

function parseSseFrame(frame: string): { event?: string; data?: string } {
  const lines = frame.split('\n');
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  return { event, data: dataLines.join('\n') };
}

async function* anthropicStream(
  config: BackendConfig,
  systemPrompt: string,
  messages: OllamaMsg[],
  tools?: OllamaToolDef[],
): AsyncGenerator<ChatChunk> {
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
    stream: true,
    system: systemPrompt,
    messages: convertToAnthropicMessages(messages),
  };
  const anthropicTools = convertToolsToAnthropic(tools);
  if (anthropicTools) body.tools = anthropicTools;

  const response = await resilientFetch(`${config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: buildAnthropicHeaders(config),
    body: JSON.stringify(body),
    retries: 2,
    timeout: 120_000,
  });

  if (!response.ok) throw new FetchError(`Anthropic HTTP ${response.status}: ${await response.text()}`, response.status, false);
  if (!response.body) throw new Error('No response body from Anthropic backend');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pendingToolCalls = new Map<number, AnthropicToolCallState>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const { event, data } = parseSseFrame(frame);
      if (!data || data === '[DONE]') {
        if (data === '[DONE]') {
          yield { content: null, done: true };
          return;
        }
        continue;
      }

      if (event === 'ping') continue;

      try {
        const parsed = JSON.parse(data) as {
          index?: number;
          delta?: { type?: string; text?: string; partial_json?: string };
          content_block?: AnthropicContentBlock;
          error?: { message?: string };
          type?: string;
        };

        if (event === 'error') {
          throw new Error(parsed.error?.message ?? 'Anthropic streaming error');
        }

        if (event === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
          pendingToolCalls.set(parsed.index ?? pendingToolCalls.size, {
            id: parsed.content_block.id ?? toolCallId('toolu'),
            name: parsed.content_block.name ?? '',
            inputText: '',
            initialInput: parsed.content_block.input,
          });
          continue;
        }

        if (event === 'content_block_delta') {
          if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
            yield { content: parsed.delta.text, done: false };
          }
          if (parsed.delta?.type === 'input_json_delta' && typeof parsed.index === 'number') {
            const existing = pendingToolCalls.get(parsed.index);
            if (existing && parsed.delta.partial_json) {
              existing.inputText += parsed.delta.partial_json;
            }
          }
          continue;
        }

        if (event === 'content_block_stop' && typeof parsed.index === 'number' && pendingToolCalls.has(parsed.index)) {
          const toolCall = anthropicToolStateToCall(pendingToolCalls.get(parsed.index)!);
          pendingToolCalls.delete(parsed.index);
          yield { content: null, toolCalls: [toolCall], done: false };
          continue;
        }

        if (event === 'message_stop') {
          yield { content: null, done: true };
          return;
        }
      } catch {
        // Ignore malformed frames and keep streaming.
      }
    }
  }
}

async function anthropicNonStream(
  config: BackendConfig,
  systemPrompt: string,
  messages: OllamaMsg[],
  tools?: OllamaToolDef[],
): Promise<ChatChunk> {
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
    stream: false,
    system: systemPrompt,
    messages: convertToAnthropicMessages(messages),
  };
  const anthropicTools = convertToolsToAnthropic(tools);
  if (anthropicTools) body.tools = anthropicTools;

  const response = await resilientFetch(`${config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: buildAnthropicHeaders(config),
    body: JSON.stringify(body),
    retries: 2,
    timeout: 120_000,
  });

  if (!response.ok) throw new FetchError(`Anthropic HTTP ${response.status}: ${await response.text()}`, response.status, false);
  const data = await response.json() as { content?: AnthropicContentBlock[] };

  const textParts: string[] = [];
  const toolCalls: NonNullable<OllamaMsg['tool_calls']> = [];
  for (const block of data.content ?? []) {
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
      continue;
    }
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id ?? toolCallId('toolu'),
        function: {
          name: block.name ?? '',
          arguments: normalizeToolArguments(block.input),
        },
      });
    }
  }

  return {
    content: textParts.join('') || null,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    done: true,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

export function chatStream(
  config: BackendConfig,
  systemPrompt: string,
  messages: OllamaMsg[],
  tools?: OllamaToolDef[],
): AsyncGenerator<ChatChunk> {
  if (config.type === 'anthropic') return anthropicStream(config, systemPrompt, messages, tools);
  if (config.type === 'openai') return openaiStream(config, systemPrompt, messages, tools);
  return ollamaStream(config, systemPrompt, messages, tools);
}

export async function chatNonStream(
  config: BackendConfig,
  systemPrompt: string,
  messages: OllamaMsg[],
  tools?: OllamaToolDef[],
): Promise<ChatChunk> {
  if (config.type === 'anthropic') return anthropicNonStream(config, systemPrompt, messages, tools);
  if (config.type === 'openai') return openaiNonStream(config, systemPrompt, messages, tools);
  return ollamaNonStream(config, systemPrompt, messages, tools);
}

/**
 * Detect backend type from a URL heuristically.
 * - Anthropic hosts or `/v1/messages` → anthropic
 * - `/v1` or known OpenAI hosts → openai
 * - localhost:11434 → ollama transport
 * - Otherwise → openai
 */
export function detectBackend(url: string): BackendType {
  const lower = url.toLowerCase();
  if (lower.includes('api.anthropic.com') || lower.includes('/v1/messages')) return 'anthropic';
  if (lower.includes('/v1') || lower.includes('api.openai.com')) return 'openai';
  if (lower.includes('localhost:11434') || lower.includes('127.0.0.1:11434')) return 'ollama';
  return 'openai';
}
