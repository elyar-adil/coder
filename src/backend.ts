/**
 * backend.ts — LLM backend abstraction.
 *
 * Supports:
 *  • Ollama (default): POST /api/chat with NDJSON streaming
 *  • OpenAI-compatible: POST /v1/chat/completions with SSE streaming
 *
 * The backend is selected via the LLM_BACKEND env var or .agentrc config.
 */

import { resilientFetch, FetchError } from './fetch.js';
import type { OllamaMsg } from './types.js';
import type { OllamaToolDef } from './tools.js';

export type BackendType = 'ollama' | 'openai';

export interface BackendConfig {
  type: BackendType;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface ChatChunk {
  content: string | null;
  toolCalls?: OllamaMsg['tool_calls'];
  done: boolean;
}

// ── Ollama backend ──────────────────────────────────────────────────────────

function parseOllamaNdjson(line: string): { message?: OllamaMsg & { content: string | null }; done?: boolean } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

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

  if (!response.ok) throw new FetchError(`Ollama HTTP ${response.status}`, response.status, false);
  if (!response.body) throw new Error('No response body from Ollama');

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
      const obj = parseOllamaNdjson(line);
      if (!obj) continue;
      if (obj.message?.content) {
        yield { content: obj.message.content, done: false };
      }
      if (obj.message?.tool_calls?.length) {
        yield { content: null, toolCalls: obj.message.tool_calls, done: false };
      }
      if (obj.done) { yield { content: null, done: true }; return; }
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

  if (!response.ok) throw new FetchError(`Ollama HTTP ${response.status}: ${await response.text()}`, response.status, false);
  const data = await response.json() as { message?: OllamaMsg & { content: string | null }; done?: boolean };
  return {
    content: data.message?.content ?? null,
    toolCalls: data.message?.tool_calls,
    done: true,
  };
}

// ── OpenAI-compatible backend ───────────────────────────────────────────────

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
  finish_reason?: string;
}

function convertToOpenAIMessages(systemPrompt: string, messages: OllamaMsg[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];
  for (const m of messages) {
    if (m.role === 'tool') {
      result.push({ role: 'tool', content: m.content });
    } else if (m.tool_calls?.length) {
      result.push({
        role: 'assistant',
        content: m.content,
        tool_calls: m.tool_calls.map((tc) => ({
          id: `call_${Math.random().toString(36).slice(2, 10)}`,
          type: 'function' as const,
          function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) },
        })),
      });
    } else {
      result.push({ role: m.role, content: m.content });
    }
  }
  return result;
}

function convertToOllamaToolCalls(openaiCalls: OpenAIToolCall[]): OllamaMsg['tool_calls'] {
  return openaiCalls.map((tc) => {
    let args: Record<string, string> = {};
    try { args = JSON.parse(tc.function.arguments); } catch { /* keep empty */ }
    return { function: { name: tc.function.name, arguments: args } };
  });
}

function convertToolsToOpenAI(tools?: OllamaToolDef[]): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
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
  const openaiTools = convertToolsToOpenAI(tools);
  if (openaiTools) body.tools = openaiTools;

  const response = await resilientFetch(`${config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    retries: 2,
    timeout: 120_000,
  });

  if (!response.ok) throw new FetchError(`OpenAI HTTP ${response.status}: ${await response.text()}`, response.status, false);
  if (!response.body) throw new Error('No response body from OpenAI');

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
        }
        if (trimmed === 'data: [DONE]') { yield { content: null, done: true }; return; }
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
          for (const tc of choice.delta.tool_calls) {
            if (tc.id) {
              pendingToolCalls.set(tc.index, {
                id: tc.id,
                type: 'function',
                function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
              });
            } else if (pendingToolCalls.has(tc.index)) {
              const existing = pendingToolCalls.get(tc.index)!;
              if (tc.function?.name) existing.function.name += tc.function.name;
              if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
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
      } catch { /* skip malformed SSE */ }
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
  const openaiTools = convertToolsToOpenAI(tools);
  if (openaiTools) body.tools = openaiTools;

  const response = await resilientFetch(`${config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    retries: 2,
    timeout: 120_000,
  });

  if (!response.ok) throw new FetchError(`OpenAI HTTP ${response.status}: ${await response.text()}`, response.status, false);
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

// ── Public API ──────────────────────────────────────────────────────────────

export function chatStream(
  config: BackendConfig,
  systemPrompt: string,
  messages: OllamaMsg[],
  tools?: OllamaToolDef[],
): AsyncGenerator<ChatChunk> {
  if (config.type === 'openai') return openaiStream(config, systemPrompt, messages, tools);
  return ollamaStream(config, systemPrompt, messages, tools);
}

export async function chatNonStream(
  config: BackendConfig,
  systemPrompt: string,
  messages: OllamaMsg[],
  tools?: OllamaToolDef[],
): Promise<ChatChunk> {
  if (config.type === 'openai') return openaiNonStream(config, systemPrompt, messages, tools);
  return ollamaNonStream(config, systemPrompt, messages, tools);
}

/**
 * Detect backend type from a URL heuristically.
 * - Paths containing "/v1" or known OpenAI hosts → openai
 * - Otherwise → ollama
 */
export function detectBackend(url: string): BackendType {
  const lower = url.toLowerCase();
  if (lower.includes('/v1')) return 'openai';
  if (lower.includes('api.openai.com')) return 'openai';
  if (lower.includes('api.anthropic.com')) return 'openai';
  if (lower.includes('localhost:11434')) return 'ollama';
  if (lower.includes('127.0.0.1:11434')) return 'ollama';
  return 'ollama';
}
