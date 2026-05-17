import { randomUUID } from 'node:crypto';
import type { PhaseEvent, PlanStep, PromptTask, TaskMode, TaskPhase } from './types.js';
import { executeTool, TOOLS } from './tools.js';
import {
  EXECUTE_SYSTEM_PROMPT,
  VERIFY_SELFIE_PROMPT,
  PLAN_SYSTEM_PROMPT,
  REACT_INSPECT_PROMPT,
  REACT_IMPLEMENT_PROMPT,
  REACT_VERIFY_PROMPT,
} from './prompts.js';

// ── Public chunk types streamed to the TUI ───────────────────────────────────
export type StreamChunk =
  | { type: 'token';       text: string }
  | { type: 'phase';       phase: TaskPhase; status: PhaseEvent['status']; note?: string }
  | { type: 'tool_call';   tool: string; input: string }
  | { type: 'tool_result'; tool: string; output: string }
  | { type: 'done';        result: string }
  | { type: 'error';       message: string };

// ── Ollama API types ──────────────────────────────────────────────────────────
export interface OllamaMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, string> };
  }>;
}

export interface OllamaStreamChunk {
  message?: OllamaMessage;
  done?: boolean;
}

// ── parsePlan — exported for testing ─────────────────────────────────────────
export function parsePlan(content: string): PlanStep[] {
  const cleaned = content.replace(/^```[a-z]*\n?/m, '').replace(/```$/m, '').trim();
  const parsed = JSON.parse(cleaned) as Array<{ title?: string; detail?: string }>;
  if (!Array.isArray(parsed)) throw new Error('Plan mode expects JSON array');
  return parsed.map((s) => ({ title: s.title ?? 'step', detail: s.detail ?? '' }));
}

// ── parseOllamaNdjson — exported for testing ──────────────────────────────────
export function parseOllamaNdjson(line: string): OllamaStreamChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as OllamaStreamChunk;
  } catch {
    return null;
  }
}

// ── MasterCoordinator ─────────────────────────────────────────────────────────
export class MasterCoordinator {
  private tasks = new Map<string, PromptTask>();

  constructor(
    private readonly ollamaBaseUrl: string,
    private readonly model: string = 'gemma4:31b-cloud',
  ) {}

  async acceptPrompt(userId: string, prompt: string, mode: TaskMode = 'execute'): Promise<string> {
    const taskId = randomUUID();
    const task: PromptTask = {
      taskId, userId, prompt, mode, status: 'queued', plan: [], phaseEvents: [],
    };
    this.tasks.set(taskId, task);
    setTimeout(() => this.runTask(taskId), 0);
    return taskId;
  }

  getTask(taskId: string): PromptTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): PromptTask[] {
    return [...this.tasks.values()];
  }

  async executePlan(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.mode !== 'plan' || task.plan.length === 0) return false;
    task.mode = 'execute';
    task.prompt = `Execute this approved plan:\n${task.plan.map((s) => `- ${s.title}: ${s.detail}`).join('\n')}`;
    void this.runTask(taskId);
    return true;
  }

  // ── Primary streaming path (used by TUI) ──────────────────────────────────
  async *streamPrompt(
    userId: string,
    prompt: string,
    mode: TaskMode = 'execute',
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  ): AsyncGenerator<StreamChunk> {
    const taskId = randomUUID();
    const task: PromptTask = {
      taskId, userId, prompt, mode, status: 'running', plan: [], phaseEvents: [],
    };
    this.tasks.set(taskId, task);

    try {
      if (mode === 'plan') {
        yield { type: 'phase', phase: 'plan', status: 'in_progress', note: 'Generating execution plan…' };
        const content = await this.callModelText(prompt, PLAN_SYSTEM_PROMPT, []);
        task.plan = parsePlan(content);
        yield { type: 'phase', phase: 'plan', status: 'done', note: `${task.plan.length} steps` };
        const planText = task.plan.map((s, i) => `**${i + 1}. ${s.title}**\n${s.detail}`).join('\n\n');
        yield { type: 'token', text: planText };
        task.result = planText;
        task.status = 'blocked';
        yield { type: 'done', result: planText };
        return;
      }

      if (mode === 'react') {
        yield* this.streamReactFlow(task, conversationHistory);
        return;
      }

      // ── execute mode: write → auto-verify → fix until green ──────────────
      yield { type: 'phase', phase: 'write_code', status: 'in_progress', note: 'Writing implementation…' };

      const messages: OllamaMessage[] = [
        ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: prompt },
      ];

      let fullResult = '';
      let filesWritten = false;
      const MAX_TURNS = 20;

      // Phase 1: Implementation tool loop
      const implResult = await this.runToolLoopStream(messages, MAX_TURNS, (chunk) => {
        if (chunk.type === 'tool_call' && chunk.tool === 'write_file') filesWritten = true;
      });
      fullResult = implResult;
      yield { type: 'phase', phase: 'write_code', status: 'done' };

      // Phase 2: If files were written, auto-verify and fix
      if (filesWritten) {
        const MAX_VERIFY_ROUNDS = 3;
        for (let vr = 0; vr < MAX_VERIFY_ROUNDS; vr++) {
          yield { type: 'phase', phase: 'verify', status: 'in_progress', note: `Verifying (attempt ${vr + 1})…` };
          const verifyResult = await this.runToolLoopStream(
            [...messages, { role: 'user', content: VERIFY_SELFIE_PROMPT }],
            MAX_TURNS,
          );
          messages.push({ role: 'assistant', content: verifyResult || null });
          fullResult += '\n' + verifyResult;

          const testOutput = verifyResult.toLowerCase();
          const hasFailure = /fail|error|traceback|exited with code/i.test(testOutput);
          if (!hasFailure && (testOutput.includes('ok') || testOutput.includes('passed') || testOutput.includes('✓'))) {
            yield { type: 'phase', phase: 'verify', status: 'done', note: 'All checks passed' };
            break;
          }

          if (vr < MAX_VERIFY_ROUNDS - 1) {
            yield { type: 'phase', phase: 'write_code', status: 'in_progress', note: 'Fixing issues…' };
          }
          if (vr === MAX_VERIFY_ROUNDS - 1) {
            yield { type: 'phase', phase: 'verify', status: 'done', note: 'Max retries reached' };
          }
        }
      }

      task.result = fullResult;
      task.status = 'completed';
      yield { type: 'done', result: fullResult };
    } catch (err) {
      task.status = 'failed';
      const msg = `Error: ${String(err)}`;
      task.result = msg;
      yield { type: 'error', message: msg };
    }
  }

  // ── React flow ─────────────────────────────────────────────────────────────
  private async *streamReactFlow(
    task: PromptTask,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): AsyncGenerator<StreamChunk> {
    yield { type: 'phase', phase: 'plan', status: 'in_progress', note: 'Building plan…' };
    const planContent = await this.callModelText(task.prompt, PLAN_SYSTEM_PROMPT, []);
    task.plan = parsePlan(planContent);
    yield { type: 'phase', phase: 'plan', status: 'done', note: `${task.plan.length} steps` };
    const planMd = task.plan.map((s, i) => `${i + 1}. **${s.title}** — ${s.detail}`).join('\n');
    yield { type: 'token', text: `## Plan\n${planMd}\n\n` };

    yield { type: 'phase', phase: 'inspect_code', status: 'in_progress', note: 'Analyzing codebase…' };
    yield { type: 'token', text: `## Analysis\n` };
    let inspectResult = '';
    yield* this.agenticStream(REACT_INSPECT_PROMPT(planMd), history, (t) => { inspectResult += t; });
    yield { type: 'phase', phase: 'inspect_code', status: 'done' };

    yield { type: 'phase', phase: 'write_code', status: 'in_progress', note: 'Writing implementation…' };
    yield { type: 'token', text: `\n\n## Implementation\n` };
    let implementation = '';
    yield* this.agenticStream(REACT_IMPLEMENT_PROMPT(planMd, inspectResult), history, (t) => { implementation += t; });
    yield { type: 'phase', phase: 'write_code', status: 'done' };

    yield { type: 'phase', phase: 'verify', status: 'in_progress', note: 'Verifying…' };
    yield { type: 'token', text: `\n\n## Verification\n` };
    let verify = '';
    yield* this.agenticStream(REACT_VERIFY_PROMPT(implementation), history, (t) => { verify += t; });
    yield { type: 'phase', phase: 'verify', status: 'done' };

    const fullResult = `## Plan\n${planMd}\n\n## Analysis\n${inspectResult}\n\n## Implementation\n${implementation}\n\n## Verification\n${verify}`;
    task.result = fullResult;
    task.status = 'completed';
    yield { type: 'done', result: fullResult };
  }

  private async *agenticStream(
    userPrompt: string,
    baseHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
    onText: (text: string) => void,
  ): AsyncGenerator<StreamChunk> {
    const messages: OllamaMessage[] = [
      ...baseHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userPrompt },
    ];

    const MAX_TURNS = 20;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let assistantText = '';
      let toolCalls: OllamaMessage['tool_calls'] = undefined;

      for await (const chunk of this.streamModelWithTools(EXECUTE_SYSTEM_PROMPT, messages)) {
        if (chunk.message?.content) {
          assistantText += chunk.message.content;
          onText(chunk.message.content);
          yield { type: 'token', text: chunk.message.content };
        }
        if (chunk.message?.tool_calls?.length) {
          toolCalls = chunk.message.tool_calls;
        }
      }

      const assistantMsg: OllamaMessage = { role: 'assistant', content: assistantText || null };
      if (toolCalls?.length) assistantMsg.tool_calls = toolCalls;
      messages.push(assistantMsg);

      if (!toolCalls?.length) break;

      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const toolArgs = tc.function.arguments;
        const inputPreview = toolArgs['command'] ?? toolArgs['path'] ?? JSON.stringify(toolArgs);

        yield { type: 'tool_call', tool: toolName, input: inputPreview };
        const result = await executeTool(toolName, toolArgs);
        yield { type: 'tool_result', tool: toolName, output: result };

        messages.push({ role: 'tool', content: result });
      }
    }
  }

  private async runToolLoopStream(
    messages: OllamaMessage[],
    maxTurns: number,
    onToolCall?: (chunk: StreamChunk) => void,
  ): Promise<string> {
    let fullResult = '';
    for (let turn = 0; turn < maxTurns; turn++) {
      let assistantText = '';
      let toolCalls: OllamaMessage['tool_calls'] = undefined;

      for await (const chunk of this.streamModelWithTools(EXECUTE_SYSTEM_PROMPT, messages)) {
        if (chunk.message?.content) {
          assistantText += chunk.message.content;
        }
        if (chunk.message?.tool_calls?.length) {
          toolCalls = chunk.message.tool_calls;
        }
      }

      const assistantMsg: OllamaMessage = { role: 'assistant', content: assistantText || null };
      if (toolCalls?.length) assistantMsg.tool_calls = toolCalls;
      messages.push(assistantMsg);
      fullResult += assistantText + '\n';

      if (!toolCalls?.length) break;

      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const toolArgs = tc.function.arguments;
        const inputPreview = toolArgs['command'] ?? toolArgs['path'] ?? JSON.stringify(toolArgs);

        const chunk: StreamChunk = { type: 'tool_call', tool: toolName, input: inputPreview };
        if (onToolCall) onToolCall(chunk);
        const result = await executeTool(toolName, toolArgs);
        messages.push({ role: 'tool', content: result });
      }
    }
    return fullResult.trim();
  }

  // ── Background task runner (non-streaming CLI path) ────────────────────────
  private markPhase(task: PromptTask, phase: TaskPhase, status: PhaseEvent['status'], note?: string): void {
    task.phaseEvents.push({ phase, status, note, ts: new Date().toISOString() });
  }

  private async runTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = 'running';

    try {
      if (task.mode === 'plan') {
        this.markPhase(task, 'plan', 'in_progress');
        const content = await this.callModelText(task.prompt, PLAN_SYSTEM_PROMPT, []);
        task.plan = parsePlan(content);
        this.markPhase(task, 'plan', 'done', `${task.plan.length} steps`);
        task.result = 'plan_ready';
        task.status = 'blocked';
        return;
      }

      if (task.mode === 'react') {
        await this.runReactFlow(task);
        return;
      }

      this.markPhase(task, 'write_code', 'in_progress');
      const messages: OllamaMessage[] = [{ role: 'user', content: task.prompt }];
      let fullResult = '';
      const MAX_TURNS = 20;
      let filesWritten = false;

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const { text, toolCalls } = await this.callModelWithTools(EXECUTE_SYSTEM_PROMPT, messages);
        const assistantMsg: OllamaMessage = { role: 'assistant', content: text || null };
        if (toolCalls?.length) assistantMsg.tool_calls = toolCalls;
        messages.push(assistantMsg);
        fullResult += text + '\n';

        if (!toolCalls?.length) break;

        for (const tc of toolCalls) {
          if (tc.function.name === 'write_file') filesWritten = true;
          const result = await executeTool(tc.function.name, tc.function.arguments);
          messages.push({ role: 'tool', content: result });
        }
      }

      this.markPhase(task, 'write_code', 'done');

      if (filesWritten) {
        const MAX_VERIFY = 3;
        for (let vr = 0; vr < MAX_VERIFY; vr++) {
          this.markPhase(task, 'verify', 'in_progress', `Verifying (attempt ${vr + 1})`);
          messages.push({ role: 'user', content: VERIFY_SELFIE_PROMPT });
          for (let turn = 0; turn < MAX_TURNS; turn++) {
            const { text, toolCalls } = await this.callModelWithTools(EXECUTE_SYSTEM_PROMPT, messages);
            const assistantMsg: OllamaMessage = { role: 'assistant', content: text || null };
            if (toolCalls?.length) assistantMsg.tool_calls = toolCalls;
            messages.push(assistantMsg);
            fullResult += '\n' + text;
            if (!toolCalls?.length) break;
            for (const tc of toolCalls) {
              const result = await executeTool(tc.function.name, tc.function.arguments);
              messages.push({ role: 'tool', content: result });
            }
          }
          const testOutput = fullResult.toLowerCase();
          if (testOutput.includes('ok') || testOutput.includes('passed') || testOutput.includes('\u2713')) {
            if (!/fail|error|traceback/.test(testOutput)) {
              this.markPhase(task, 'verify', 'done', 'All checks passed');
              break;
            }
          }
          if (vr < MAX_VERIFY - 1) this.markPhase(task, 'write_code', 'in_progress', 'Fixing issues…');
          if (vr === MAX_VERIFY - 1) this.markPhase(task, 'verify', 'done', 'Max retries reached');
        }
      }

      task.result = fullResult;
      task.status = 'completed';
    } catch (err) {
      task.status = 'failed';
      task.result = `Agent failed: ${String(err)}`;
      this.markPhase(task, 'finalize', 'failed', task.result);
    }
  }

  private async runToolLoop(
    userPrompt: string,
    systemPrompt: string,
  ): Promise<string> {
    const messages: OllamaMessage[] = [{ role: 'user', content: userPrompt }];
    let fullResult = '';
    const MAX_TURNS = 20;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const { text, toolCalls } = await this.callModelWithTools(systemPrompt, messages);
      const assistantMsg: OllamaMessage = { role: 'assistant', content: text || null };
      if (toolCalls?.length) assistantMsg.tool_calls = toolCalls;
      messages.push(assistantMsg);
      fullResult += text + '\n';
      if (!toolCalls?.length) break;
      for (const tc of toolCalls) {
        const result = await executeTool(tc.function.name, tc.function.arguments);
        messages.push({ role: 'tool', content: result });
      }
    }
    return fullResult.trim();
  }

  private async runReactFlow(task: PromptTask): Promise<void> {
    this.markPhase(task, 'plan', 'in_progress');
    const planContent = await this.callModelText(task.prompt, PLAN_SYSTEM_PROMPT, []);
    task.plan = parsePlan(planContent);
    this.markPhase(task, 'plan', 'done');

    const planMd = task.plan.map((s, i) => `${i + 1}. ${s.title} — ${s.detail}`).join('\n');

    this.markPhase(task, 'inspect_code', 'in_progress');
    const inspectResult = await this.runToolLoop(
      REACT_INSPECT_PROMPT(planMd), EXECUTE_SYSTEM_PROMPT,
    );
    this.markPhase(task, 'inspect_code', 'done');

    this.markPhase(task, 'write_code', 'in_progress');
    const implementation = await this.runToolLoop(
      REACT_IMPLEMENT_PROMPT(planMd, inspectResult), EXECUTE_SYSTEM_PROMPT,
    );
    this.markPhase(task, 'write_code', 'done');

    this.markPhase(task, 'verify', 'in_progress');
    const verify = await this.runToolLoop(
      REACT_VERIFY_PROMPT(implementation), EXECUTE_SYSTEM_PROMPT,
    );
    this.markPhase(task, 'verify', 'done');

    task.result = `## Plan\n${planMd}\n\n## Analysis\n${inspectResult}\n\n## Implementation\n${implementation}\n\n## Verification\n${verify}`;
    this.markPhase(task, 'finalize', 'done');
    task.status = 'completed';
  }

  // ── Ollama API calls ───────────────────────────────────────────────────────
  private async *streamModelWithTools(
    systemPrompt: string,
    messages: OllamaMessage[],
  ): AsyncGenerator<OllamaStreamChunk> {
    const body = {
      model: this.model,
      stream: false,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      tools: TOOLS,
    };

    const response = await fetch(`${this.ollamaBaseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const data = await response.json() as OllamaStreamChunk;
    yield data;
  }

  private async callModelWithTools(
    systemPrompt: string,
    messages: OllamaMessage[],
  ): Promise<{ text: string; toolCalls: OllamaMessage['tool_calls'] }> {
    let text = '';
    let toolCalls: OllamaMessage['tool_calls'] = undefined;
    for await (const chunk of this.streamModelWithTools(systemPrompt, messages)) {
      if (chunk.message?.content) text += chunk.message.content;
      if (chunk.message?.tool_calls?.length) toolCalls = chunk.message.tool_calls;
    }
    return { text: text.trim(), toolCalls };
  }

  private async *streamModelText(
    systemPrompt: string,
    messages: OllamaMessage[],
  ): AsyncGenerator<string> {
    const body = {
      model: this.model,
      stream: true,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    };

    const response = await fetch(`${this.ollamaBaseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    if (!response.body) throw new Error('No response body');

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
        if (obj?.message?.content) yield obj.message.content;
        if (obj?.done) return;
      }
    }
  }

  private async callModelText(
    userPrompt: string,
    systemPrompt: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<string> {
    const messages: OllamaMessage[] = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      ...(userPrompt ? [{ role: 'user', content: userPrompt }] : []),
    ];
    let full = '';
    for await (const chunk of this.streamModelText(systemPrompt, messages)) {
      full += chunk;
    }
    return full.trim();
  }
}
