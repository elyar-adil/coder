import { randomUUID } from 'node:crypto';
import type { PhaseEvent, PlanStep, PromptTask, SubAgentTask, TaskMode, TaskPhase, ToolContext, OllamaMsg } from './types.js';
import { executeTool, TOOLS } from './tools.js';
import { TaskStore, ResponseCache } from './store.js';
import { chatStream, chatNonStream } from './backend.js';
import type { BackendConfig } from './backend.js';
import {
  EXECUTE_SYSTEM_PROMPT,
  DESIGN_TOOLS_PROMPT,
  VERIFY_SELFIE_PROMPT,
  SUBAGENT_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  REACT_INSPECT_PROMPT,
  REACT_IMPLEMENT_PROMPT,
  REACT_VERIFY_PROMPT,
} from './prompts.js';

export type StreamChunk =
  | { type: 'task_id';     taskId: string }
  | { type: 'token';       text: string }
  | { type: 'phase';       phase: TaskPhase; status: PhaseEvent['status']; note?: string }
  | { type: 'tool_call';   tool: string; input: string }
  | { type: 'tool_result'; tool: string; output: string }
  | { type: 'ask_user';    question: string }
  | { type: 'done';        result: string }
  | { type: 'error';       message: string };

export interface OllamaStreamChunk {
  message?: OllamaMsg & { content: string | null };
  done?: boolean;
}

export function parsePlan(content: string): PlanStep[] {
  const cleaned = content.replace(/^```[a-z]*\n?/m, '').replace(/```$/m, '').trim();
  const parsed = JSON.parse(cleaned) as Array<{ title?: string; detail?: string }>;
  if (!Array.isArray(parsed)) throw new Error('Plan mode expects JSON array');
  return parsed.map((s) => ({ title: s.title ?? 'step', detail: s.detail ?? '' }));
}

export function parseOllamaNdjson(line: string): OllamaStreamChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as OllamaStreamChunk;
  } catch {
    return null;
  }
}

export class MasterCoordinator {
  private tasks = new Map<string, PromptTask>();
  private subagents = new Map<string, SubAgentTask>();
  private store = new TaskStore();
  private cache = new ResponseCache();
  private userAnswer = new Map<string, (answer: string) => void>();
  private backend: BackendConfig;

  constructor(
    baseUrlOrConfig: string | BackendConfig,
    model?: string,
  ) {
    if (typeof baseUrlOrConfig === 'object') {
      this.backend = baseUrlOrConfig;
    } else {
      this.backend = {
        type: 'ollama',
        baseUrl: baseUrlOrConfig,
        model: model ?? 'gemma4:31b-cloud',
      };
    }
    this.store.init().then(() => this.loadPersistedTasks());
  }

  private async loadPersistedTasks(): Promise<void> {
    const tasks = await this.store.list();
    for (const t of tasks) {
      this.tasks.set(t.taskId, t);
    }
  }

  private async persist(task: PromptTask): Promise<void> {
    await this.store.save(task);
  }

  // ── User answer injection (called by TUI) ───────────────────────────────────
  answerUser(taskId: string, answer: string): void {
    const resolve = this.userAnswer.get(taskId);
    if (resolve) {
      resolve(answer);
      this.userAnswer.delete(taskId);
    }
  }

  // ── Task management ─────────────────────────────────────────────────────────
  async acceptPrompt(userId: string, prompt: string, mode: TaskMode = 'execute'): Promise<string> {
    const taskId = randomUUID();
    const task: PromptTask = {
      taskId, userId, prompt, mode, status: 'queued', plan: [], phaseEvents: [], messages: [],
    };
    this.tasks.set(taskId, task);
    this.persist(task);
    setTimeout(() => this.runTask(taskId), 0);
    return taskId;
  }

  getTask(taskId: string): PromptTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): PromptTask[] {
    return [...this.tasks.values()];
  }

  async deleteTask(taskId: string): Promise<void> {
    this.tasks.delete(taskId);
    await this.store.remove(taskId);
  }

  listSubagents(): SubAgentTask[] {
    return [...this.subagents.values()];
  }

  getSubagent(id: string): SubAgentTask | undefined {
    return this.subagents.get(id);
  }

  async executePlan(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.mode !== 'plan' || task.plan.length === 0) return false;
    task.mode = 'execute';
    task.prompt = `Execute this approved plan:\n${task.plan.map((s) => `- ${s.title}: ${s.detail}`).join('\n')}`;
    void this.runTask(taskId);
    return true;
  }

  async spawnSubagent(prompt: string): Promise<string> {
    const subId = randomUUID();
    const sub: SubAgentTask = {
      taskId: subId, parentTaskId: '', prompt, status: 'running',
      createdAt: new Date().toISOString(),
    };
    this.subagents.set(subId, sub);
    this.runSubagent(subId);
    return subId;
  }

  async collectSubagent(subId: string): Promise<string> {
    const sub = this.subagents.get(subId);
    if (!sub) return `Error: subagent "${subId}" not found`;
    if (sub.status === 'running') return `Subagent ${subId.slice(0, 8)} still running (started ${sub.createdAt})`;
    return sub.result ?? `Subagent ${subId.slice(0, 8)} completed with no result`;
  }

  private async runSubagent(subId: string): Promise<void> {
    const sub = this.subagents.get(subId);
    if (!sub) return;
    try {
      const messages: OllamaMsg[] = [{ role: 'user', content: sub.prompt }];
      let result = '';
      for (let turn = 0; turn < 20; turn++) {
        const { text, toolCalls } = await this.callModelWithTools(SUBAGENT_SYSTEM_PROMPT, messages);
        const msg: OllamaMsg = { role: 'assistant', content: text || null };
        if (toolCalls?.length) msg.tool_calls = toolCalls;
        messages.push(msg);
        result += text + '\n';
        if (!toolCalls?.length) break;
        for (const tc of toolCalls) {
          const res = await executeTool(tc.function.name, tc.function.arguments);
          messages.push({ role: 'tool', content: res });
        }
      }
      sub.result = result.trim();
      sub.status = 'completed';
      sub.completedAt = new Date().toISOString();
    } catch (err) {
      sub.status = 'failed';
      sub.result = `Subagent failed: ${String(err)}`;
      sub.completedAt = new Date().toISOString();
    }
  }

  // ── Resolve a task with an existing saved task ──────────────────────────────
  async resolveTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'completed' || task.status === 'failed') return false;
    // Re-run from scratch but keep the taskId
    setTimeout(() => this.runTask(taskId), 0);
    return true;
  }

  // ── Streaming prompt (used by TUI) ──────────────────────────────────────────
  async *streamPrompt(
    userId: string,
    prompt: string,
    mode: TaskMode = 'execute',
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  ): AsyncGenerator<StreamChunk> {
    const taskId = randomUUID();
    const task: PromptTask = {
      taskId, userId, prompt, mode, status: 'running', plan: [], phaseEvents: [], messages: [],
    };
    this.tasks.set(taskId, task);
    this.persist(task);
    yield { type: 'task_id', taskId };

    const toolCtx: ToolContext = {
      spawnSubagent: (p) => this.spawnSubagent(p),
      collectSubagent: (id) => this.collectSubagent(id),
      askUser: (question) => this.askUserInStream(taskId, question),
    };

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
        this.persist(task);
        yield { type: 'done', result: planText };
        return;
      }

      if (mode === 'react') {
        yield* this.streamReactFlow(task, conversationHistory, toolCtx);
        this.persist(task);
        return;
      }

      // ── Execute mode ──────────────────────────────────────────────────────
      const messages: OllamaMsg[] = [
        ...conversationHistory.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: prompt },
      ];
      let fullResult = '';
      const MAX_TURNS = 20;

      // Phase 1: Design (with tools — can read files)
      yield { type: 'phase', phase: 'design', status: 'in_progress', note: 'Exploring codebase and designing…' };
      const designResult = await this.runToolLoopStream(
        [...messages, { role: 'user', content: DESIGN_TOOLS_PROMPT }],
        MAX_TURNS, toolCtx,
      );
      messages.push({ role: 'assistant', content: `## Design\n${designResult}` });
      fullResult += `## Design\n${designResult}\n\n`;
      task.designDoc = designResult;
      yield { type: 'token', text: `## Design\n${designResult}\n\n` };
      yield { type: 'phase', phase: 'design', status: 'done' };
      task.messages = [...messages];
      this.persist(task);

      // Phase 2: Implement
      yield { type: 'phase', phase: 'write_code', status: 'in_progress', note: 'Writing implementation…' };
      let filesWritten = false;
      const implResult = await this.runToolLoopStream(
        messages, MAX_TURNS, toolCtx,
        (tool) => { if (tool === 'write_file') filesWritten = true; },
      );
      fullResult += implResult;
      task.messages = [...messages];
      this.persist(task);
      yield { type: 'phase', phase: 'write_code', status: 'done' };

      // Phase 3: Verify and fix
      if (filesWritten) {
        const MAX_VERIFY_ROUNDS = 3;
        for (let vr = 0; vr < MAX_VERIFY_ROUNDS; vr++) {
          yield { type: 'phase', phase: 'verify', status: 'in_progress', note: `Verifying (attempt ${vr + 1})…` };
          const verifyResult = await this.runToolLoopStream(
            [...messages, { role: 'user', content: VERIFY_SELFIE_PROMPT }],
            MAX_TURNS, toolCtx,
          );
          messages.push({ role: 'assistant', content: verifyResult || null });
          fullResult += '\n' + verifyResult;
          task.messages = [...messages];
          this.persist(task);

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

      task.messages = messages;
      task.result = fullResult;
      task.status = 'completed';
      this.persist(task);
      yield { type: 'done', result: fullResult };
    } catch (err) {
      task.status = 'failed';
      const msg = `Error: ${String(err)}`;
      task.result = msg;
      this.persist(task);
      yield { type: 'error', message: msg };
    }
  }

  private askUserInStream(taskId: string, question: string): Promise<string> {
    return new Promise((resolve) => {
      this.userAnswer.set(taskId, resolve);
      // The TUI will see that we set this and call answerUser()
    });
  }

  // ── React streaming flow ───────────────────────────────────────────────────
  private async *streamReactFlow(
    task: PromptTask,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    toolCtx: ToolContext,
  ): AsyncGenerator<StreamChunk> {
    yield { type: 'phase', phase: 'plan', status: 'in_progress', note: 'Building plan…' };
    const planContent = await this.callModelText(task.prompt, PLAN_SYSTEM_PROMPT, []);
    task.plan = parsePlan(planContent);
    yield { type: 'phase', phase: 'plan', status: 'done', note: `${task.plan.length} steps` };
    const planMd = task.plan.map((s, i) => `${i + 1}. **${s.title}** — ${s.detail}`).join('\n');
    yield { type: 'token', text: `## Plan\n${planMd}\n\n` };

    yield { type: 'phase', phase: 'design', status: 'in_progress', note: 'Exploring + designing…' };
    yield { type: 'token', text: `## Design\n` };
    const messages: OllamaMsg[] = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: `Plan:\n${planMd}\n\n${DESIGN_TOOLS_PROMPT}` },
    ];
    let designText = '';
    for await (const _c of this.agenticStreamRaw(messages, toolCtx, (t) => { designText += t; })) { /* collect */ }
    yield { type: 'token', text: designText + '\n\n' };
    task.designDoc = designText;
    yield { type: 'phase', phase: 'design', status: 'done' };
    this.persist(task);

    yield { type: 'phase', phase: 'inspect_code', status: 'in_progress', note: 'Analyzing codebase…' };
    yield { type: 'token', text: `## Analysis\n` };
    let inspectResult = '';
    yield* this.agenticStream(REACT_INSPECT_PROMPT(planMd), history, toolCtx, (t) => { inspectResult += t; });
    yield { type: 'phase', phase: 'inspect_code', status: 'done' };

    yield { type: 'phase', phase: 'write_code', status: 'in_progress', note: 'Writing implementation…' };
    yield { type: 'token', text: `\n\n## Implementation\n` };
    let implementation = '';
    yield* this.agenticStream(REACT_IMPLEMENT_PROMPT(planMd, `${designText}\n${inspectResult}`), history, toolCtx, (t) => { implementation += t; });
    yield { type: 'phase', phase: 'write_code', status: 'done' };

    yield { type: 'phase', phase: 'verify', status: 'in_progress', note: 'Verifying…' };
    yield { type: 'token', text: `\n\n## Verification\n` };
    let verify = '';
    yield* this.agenticStream(REACT_VERIFY_PROMPT(implementation), history, toolCtx, (t) => { verify += t; });
    yield { type: 'phase', phase: 'verify', status: 'done' };

    const fullResult = `## Plan\n${planMd}\n\n## Design\n${designText}\n\n## Analysis\n${inspectResult}\n\n## Implementation\n${implementation}\n\n## Verification\n${verify}`;
    task.result = fullResult;
    task.status = 'completed';
    yield { type: 'done', result: fullResult };
  }

  private async *agenticStreamRaw(
    messages: OllamaMsg[],
    toolCtx: ToolContext,
    onText: (text: string) => void,
  ): AsyncGenerator<StreamChunk> {
    for (let turn = 0; turn < 20; turn++) {
      let assistantText = '';
      let toolCalls: OllamaMsg['tool_calls'] = undefined;

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

      const msg: OllamaMsg = { role: 'assistant', content: assistantText || null };
      if (toolCalls?.length) msg.tool_calls = toolCalls;
      messages.push(msg);

      if (!toolCalls?.length) break;

      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const toolArgs = tc.function.arguments;
        const preview = toolArgs['command'] ?? toolArgs['path'] ?? JSON.stringify(toolArgs);
        yield { type: 'tool_call', tool: toolName, input: preview };

        if (toolName === 'ask_user') {
          yield { type: 'ask_user', question: toolArgs['question'] ?? '' };
        }

        const result = await executeTool(toolName, toolArgs, toolCtx);
        yield { type: 'tool_result', tool: toolName, output: result };
        messages.push({ role: 'tool', content: result });
      }
    }
  }

  private async *agenticStream(
    userPrompt: string,
    baseHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
    toolCtx: ToolContext,
    onText: (text: string) => void,
  ): AsyncGenerator<StreamChunk> {
    const messages: OllamaMsg[] = [
      ...baseHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userPrompt },
    ];
    yield* this.agenticStreamRaw(messages, toolCtx, onText);
  }

  private async runToolLoopStream(
    messages: OllamaMsg[],
    maxTurns: number,
    toolCtx: ToolContext,
    onToolCall?: (tool: string) => void,
  ): Promise<string> {
    let fullResult = '';
    for (let turn = 0; turn < maxTurns; turn++) {
      let assistantText = '';
      let toolCalls: OllamaMsg['tool_calls'] = undefined;

      for await (const chunk of this.streamModelWithTools(EXECUTE_SYSTEM_PROMPT, messages)) {
        if (chunk.message?.content) {
          assistantText += chunk.message.content;
        }
        if (chunk.message?.tool_calls?.length) {
          toolCalls = chunk.message.tool_calls;
        }
      }

      const msg: OllamaMsg = { role: 'assistant', content: assistantText || null };
      if (toolCalls?.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      fullResult += assistantText + '\n';

      if (!toolCalls?.length) break;

      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const toolArgs = tc.function.arguments;
        if (onToolCall) onToolCall(toolName);
        const result = await executeTool(toolName, toolArgs, toolCtx);
        messages.push({ role: 'tool', content: result });
      }
    }
    return fullResult.trim();
  }

  // ── Background task runner (non-streaming) ──────────────────────────────────
  private markPhase(task: PromptTask, phase: TaskPhase, status: PhaseEvent['status'], note?: string): void {
    task.phaseEvents.push({ phase, status, note, ts: new Date().toISOString() });
    this.persist(task);
  }

  private async runTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = 'running';
    this.persist(task);

    const toolCtx: ToolContext = {
      spawnSubagent: (p) => this.spawnSubagent(p),
      collectSubagent: (id) => this.collectSubagent(id),
      askUser: async (question) => {
        process.stdout.write(`\n[Agent asks] ${question}\n> `);
        return new Promise((resolve) => {
          process.stdin.once('data', (d) => resolve(d.toString().trim()));
        });
      },
    };

    try {
      if (task.mode === 'plan') {
        this.markPhase(task, 'plan', 'in_progress');
        const content = await this.callModelText(task.prompt, PLAN_SYSTEM_PROMPT, []);
        task.plan = parsePlan(content);
        this.markPhase(task, 'plan', 'done', `${task.plan.length} steps`);
        task.result = 'plan_ready';
        task.status = 'blocked';
        this.persist(task);
        return;
      }

      if (task.mode === 'react') {
        await this.runReactFlow(task, toolCtx);
        this.persist(task);
        return;
      }

      // Execute mode
      const messages: OllamaMsg[] = [{ role: 'user', content: task.prompt }];
      let fullResult = '';
      const MAX_TURNS = 20;

      this.markPhase(task, 'design', 'in_progress');
      const designResult = await this.runToolLoopNonStream(
        [...messages, { role: 'user', content: DESIGN_TOOLS_PROMPT }],
        MAX_TURNS, EXECUTE_SYSTEM_PROMPT, toolCtx,
      );
      messages.push({ role: 'assistant', content: `## Design\n${designResult}` });
      fullResult += `## Design\n${designResult}\n\n`;
      task.designDoc = designResult;
      this.markPhase(task, 'design', 'done');

      this.markPhase(task, 'write_code', 'in_progress');
      let filesWritten = false;
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const { text, toolCalls } = await this.callModelWithTools(EXECUTE_SYSTEM_PROMPT, messages);
        const msg: OllamaMsg = { role: 'assistant', content: text || null };
        if (toolCalls?.length) msg.tool_calls = toolCalls;
        messages.push(msg);
        fullResult += text + '\n';
        if (!toolCalls?.length) break;
        for (const tc of toolCalls) {
          if (tc.function.name === 'write_file') filesWritten = true;
          const result = await executeTool(tc.function.name, tc.function.arguments, toolCtx);
          messages.push({ role: 'tool', content: result });
        }
      }
      this.markPhase(task, 'write_code', 'done');

      if (filesWritten) {
        for (let vr = 0; vr < 3; vr++) {
          this.markPhase(task, 'verify', 'in_progress', `Verifying (attempt ${vr + 1})`);
          messages.push({ role: 'user', content: VERIFY_SELFIE_PROMPT });
          for (let turn = 0; turn < MAX_TURNS; turn++) {
            const { text, toolCalls } = await this.callModelWithTools(EXECUTE_SYSTEM_PROMPT, messages);
            const msg: OllamaMsg = { role: 'assistant', content: text || null };
            if (toolCalls?.length) msg.tool_calls = toolCalls;
            messages.push(msg);
            fullResult += '\n' + text;
            if (!toolCalls?.length) break;
            for (const tc of toolCalls) {
              const result = await executeTool(tc.function.name, tc.function.arguments, toolCtx);
              messages.push({ role: 'tool', content: result });
            }
          }
          if (this.verifyPassed(fullResult)) {
            this.markPhase(task, 'verify', 'done', 'All checks passed');
            break;
          }
          if (vr === 2) this.markPhase(task, 'verify', 'done', 'Max retries reached');
          else this.markPhase(task, 'write_code', 'in_progress', 'Fixing issues…');
        }
      }

      task.messages = messages;
      task.result = fullResult;
      task.status = 'completed';
      this.persist(task);
    } catch (err) {
      task.status = 'failed';
      task.result = `Agent failed: ${String(err)}`;
      this.markPhase(task, 'finalize', 'failed', task.result);
    }
  }

  private verifyPassed(output: string): boolean {
    const lower = output.toLowerCase();
    if (lower.includes('ok') || lower.includes('passed') || lower.includes('\u2713')) {
      return !/fail|error|traceback/.test(lower);
    }
    return false;
  }

  private async runToolLoopNonStream(
    messages: OllamaMsg[],
    maxTurns: number,
    systemPrompt: string,
    toolCtx: ToolContext,
  ): Promise<string> {
    let fullResult = '';
    for (let turn = 0; turn < maxTurns; turn++) {
      const { text, toolCalls } = await this.callModelWithTools(systemPrompt, messages);
      const msg: OllamaMsg = { role: 'assistant', content: text || null };
      if (toolCalls?.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      fullResult += text + '\n';
      if (!toolCalls?.length) break;
      for (const tc of toolCalls) {
        const result = await executeTool(tc.function.name, tc.function.arguments, toolCtx);
        messages.push({ role: 'tool', content: result });
      }
    }
    return fullResult.trim();
  }

  private async runToolLoop(
    userPrompt: string,
    systemPrompt: string,
    toolCtx?: ToolContext,
  ): Promise<string> {
    const messages: OllamaMsg[] = [{ role: 'user', content: userPrompt }];
    const ctx = toolCtx ?? {
      spawnSubagent: async () => 'unavailable',
      collectSubagent: async () => 'unavailable',
    };
    return this.runToolLoopNonStream(messages, 20, systemPrompt, ctx);
  }

  private async runReactFlow(task: PromptTask, toolCtx: ToolContext): Promise<void> {
    this.markPhase(task, 'plan', 'in_progress');
    const planContent = await this.callModelText(task.prompt, PLAN_SYSTEM_PROMPT, []);
    task.plan = parsePlan(planContent);
    this.markPhase(task, 'plan', 'done');
    const planMd = task.plan.map((s, i) => `${i + 1}. ${s.title} — ${s.detail}`).join('\n');

    this.markPhase(task, 'design', 'in_progress');
    const designText = await this.runToolLoopNonStream(
      [{ role: 'user', content: `Plan:\n${planMd}\n\n${DESIGN_TOOLS_PROMPT}` }],
      20, EXECUTE_SYSTEM_PROMPT, toolCtx,
    );
    task.designDoc = designText;
    this.markPhase(task, 'design', 'done');

    this.markPhase(task, 'inspect_code', 'in_progress');
    const inspectResult = await this.runToolLoop(REACT_INSPECT_PROMPT(planMd), EXECUTE_SYSTEM_PROMPT, toolCtx);
    this.markPhase(task, 'inspect_code', 'done');

    this.markPhase(task, 'write_code', 'in_progress');
    const fullInspect = `## Design\n${designText}\n\n## Codebase Inspection\n${inspectResult}`;
    const implementation = await this.runToolLoop(REACT_IMPLEMENT_PROMPT(planMd, fullInspect), EXECUTE_SYSTEM_PROMPT, toolCtx);
    this.markPhase(task, 'write_code', 'done');

    this.markPhase(task, 'verify', 'in_progress');
    const verify = await this.runToolLoop(REACT_VERIFY_PROMPT(implementation), EXECUTE_SYSTEM_PROMPT, toolCtx);
    this.markPhase(task, 'verify', 'done');

    task.result = `## Plan\n${planMd}\n\n## Design\n${designText}\n\n## Analysis\n${inspectResult}\n\n## Implementation\n${implementation}\n\n## Verification\n${verify}`;
    this.markPhase(task, 'finalize', 'done');
    task.status = 'completed';
  }

  // ── LLM API calls (backend-agnostic) ───────────────────────────────────────
  private async *streamModelWithTools(
    systemPrompt: string,
    messages: OllamaMsg[],
  ): AsyncGenerator<OllamaStreamChunk> {
    for await (const chunk of chatStream(this.backend, systemPrompt, messages, TOOLS)) {
      const ollamaChunk: OllamaStreamChunk = {};
      if (chunk.content !== null) ollamaChunk.message = { role: 'assistant', content: chunk.content };
      if (chunk.toolCalls) ollamaChunk.message = { ...ollamaChunk.message, role: 'assistant', content: ollamaChunk.message?.content ?? null, tool_calls: chunk.toolCalls };
      if (chunk.done) ollamaChunk.done = true;
      if (ollamaChunk.message || ollamaChunk.done) yield ollamaChunk;
    }
  }

  private async callModelWithTools(
    systemPrompt: string,
    messages: OllamaMsg[],
  ): Promise<{ text: string; toolCalls: OllamaMsg['tool_calls'] }> {
    const cached = this.cache.get(this.backend.model, systemPrompt, JSON.stringify(messages));
    if (cached) return JSON.parse(cached);

    let text = '';
    let toolCalls: OllamaMsg['tool_calls'] = undefined;
    for await (const chunk of this.streamModelWithTools(systemPrompt, messages)) {
      if (chunk.message?.content) text += chunk.message.content;
      if (chunk.message?.tool_calls?.length) toolCalls = chunk.message.tool_calls;
    }
    const result = { text: text.trim(), toolCalls };
    this.cache.set(this.backend.model, systemPrompt, JSON.stringify(messages), JSON.stringify(result));
    return result;
  }

  private async *streamModelText(
    systemPrompt: string,
    messages: OllamaMsg[],
  ): AsyncGenerator<string> {
    for await (const chunk of chatStream(this.backend, systemPrompt, messages)) {
      if (chunk.content) yield chunk.content;
      if (chunk.done) return;
    }
  }

  private async callModelText(
    userPrompt: string,
    systemPrompt: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<string> {
    const messages: OllamaMsg[] = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      ...(userPrompt ? [{ role: 'user', content: userPrompt }] : []),
    ];

    const cached = this.cache.get(this.backend.model, systemPrompt, JSON.stringify(messages));
    if (cached) return cached;

    let full = '';
    for await (const chunk of this.streamModelText(systemPrompt, messages)) {
      full += chunk;
    }
    const result = full.trim();
    this.cache.set(this.backend.model, systemPrompt, JSON.stringify(messages), result);
    return result;
  }
}
