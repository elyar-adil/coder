import type { BackendConfig, ChatChunk } from './backend.js';
import type { AgentModelMessage } from './domain/agent.js';
import type { ToolDefinition } from './tools/types.js';
import { resilientFetch, FetchError } from './fetch.js';

export async function* responsesStream(config: BackendConfig, instructions: string, messages: AgentModelMessage[], tools?: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<ChatChunk> {
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.responseItems) input.push(...message.responseItems);
    if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.tool_use_id, output: message.content ?? '' });
    else {
      if (message.content) input.push({ role: message.role, content: message.content });
      for (const call of message.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: JSON.stringify(call.function.arguments) });
      }
    }
  }
  const options = config.requestOptions;
  const body = {
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
    ...(options?.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}),
    ...options?.extraBody,
    model: config.model, instructions, input, stream: true, store: false,
    include: ['reasoning.encrypted_content'],
    ...(tools?.length ? { tools: tools.map(({ function: fn }) => ({ type: 'function', name: fn.name, description: fn.description, parameters: fn.parameters, strict: false })) } : {}),
  };
  const base = config.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const response = await resilientFetch(`${base}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
    body: JSON.stringify(body), signal, timeout: 120_000, retries: 2,
  });
  if (!response.ok) throw new FetchError(`Responses HTTP ${response.status}: ${await response.text()}`, response.status, false);
  if (!response.body) throw new Error('Responses returned no stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() + '\n\n' : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data) as {
          type: string; delta?: string; message?: string;
          item?: Record<string, unknown> & { type?: string; call_id?: string; name?: string; arguments?: string };
          response?: { error?: { message?: string }; incomplete_details?: { reason?: string } };
        };
        if (event.type === 'response.output_text.delta' && event.delta) yield { content: event.delta, done: false };
        if (event.type === 'response.reasoning_summary_text.delta' && event.delta) yield { content: null, thinking: event.delta, done: false };
        if (event.type === 'response.output_item.done' && event.item?.type === 'reasoning') {
          yield { content: null, responseItems: [event.item], done: false };
        }
        if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
          const item = event.item;
          if (!item.call_id || !item.name) throw new Error('Responses returned an incomplete tool call');
          yield { content: null, toolCalls: [{ id: item.call_id, function: { name: item.name, arguments: JSON.parse(item.arguments ?? '{}') } }], done: false };
        }
        if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) {
          throw new Error(event.response?.error?.message ?? event.message ?? event.response?.incomplete_details?.reason ?? `Responses: ${event.type}`);
        }
        if (event.type === 'response.completed') { yield { content: null, done: true }; return; }
      }
      if (done) throw new Error('Responses stream ended before completion');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
