import { randomUUID } from 'node:crypto';

import type { BackendConfig } from '../backend.js';
import { chatStream } from '../backend.js';
import type {
  ClarificationRequest,
  MasterEvent,
  OllamaMsg,
  PlanStep,
  PlannerDecision,
  PromptTask,
  SharedContextSnapshot,
  SubAgentTask,
  TaskMode,
  TaskPhase,
  ToolContext,
} from '../domain/task.js';
import { readOnlyPolicy } from '../policy.js';
import type { PhaseEvent } from '../types.js';
import {
  CHAT_SYSTEM_PROMPT,
  DESIGN_TOOLS_PROMPT,
  EXECUTE_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  REACT_IMPLEMENT_PROMPT,
  REACT_INSPECT_PROMPT,
  REACT_VERIFY_PROMPT,
  ROUTER_SYSTEM_PROMPT,
  SUBAGENT_SYSTEM_PROMPT,
  VERIFY_SELFIE_PROMPT,
} from '../infra/prompts.js';
import { WORKER_TOOLS, executeTool, getToolPolicy } from '../infra/tools.js';
import { ResponseCache, TaskStore, type ConversationEntry } from '../store.js';
import { SubagentManager } from '../subagentManager.js';
import { telemetry } from '../telemetry.js';
import { FileLockManager } from './locks.js';
import {
  fallbackPlannerDecision,
  parseOllamaNdjson,
  parsePlan,
  parsePlannerDecision,
  renderSharedContext,
  type OllamaStreamChunk,
} from './planner.js';

export type StreamChunk =
  | { type: 'task_id'; taskId: string }
  | { type: 'token'; text: string }
  | { type: 'phase'; phase: TaskPhase; status: PhaseEvent['status']; note?: string }
  | { type: 'tool_call'; tool: string; input: string }
  | { type: 'tool_result'; tool: string; output: string }
  | { type: 'ask_user'; question: string; clarificationId?: string }
  | { type: 'done'; result: string }
  | { type: 'error'; message: string };

type EventListener = (event: MasterEvent) => void;

function now(): string {
  return new Date().toISOString();
}

function excerpt(value: string | undefined, max = 200): string {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isRepoScopedPrompt(prompt: string): boolean {
  return /\b(repo|repository|project|module|function|file|src|test|bug|build|code|task)\b/i.test(prompt);
}

export class MasterCoordinator {
  private tasks = new Map<string, PromptTask>();
  private taskHistory = new Map<string, ConversationEntry[]>();
  private subagents = new Map<string, SubAgentTask>();
  private clarifications = new Map<string, { taskId: string; resolve: (answer: string) => void }>();
  private listeners = new Set<EventListener>();
  private store = new TaskStore();
  private cache = new ResponseCache();
  private backend: BackendConfig;
  private subagentManager = new SubagentManager(2);
  private fileLocks = new FileLockManager();
  private sharedSummary = '';
  private basePolicy = getToolPolicy();

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

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: MasterEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async loadPersistedTasks(): Promise<void> {
    const tasks = await this.store.list();
    for (const task of tasks) {
      this.tasks.set(task.taskId, task);
      if (task.status === 'completed' || task.status === 'failed') {
        this.rememberTask(task);
      }
    }
  }

  private cloneTask(task: PromptTask): PromptTask {
    return {
      ...task,
      plan: [...task.plan],
      phaseEvents: [...task.phaseEvents],
      messages: task.messages ? [...task.messages] : undefined,
      pendingClarifications: task.pendingClarifications ? [...task.pendingClarifications] : undefined,
    };
  }

  private async persist(task: PromptTask): Promise<void> {
    task.updatedAt = now();
    await this.store.save(task);
  }

  private emitTaskUpdate(task: PromptTask): void {
    this.emit({ type: 'task_updated', task: this.cloneTask(task), ts: now() });
  }

  private rememberTask(task: PromptTask): void {
    const line = `${task.taskId.slice(0, 8)} [${task.status}] ${excerpt(task.summary ?? task.prompt, 120)}${task.result ? ` => ${excerpt(task.result, 140)}` : ''}`;
    const lines = [line, ...this.sharedSummary.split('\n').filter(Boolean)];
    this.sharedSummary = lines.slice(0, 8).join('\n');
  }

  private buildSharedSnapshot(excludeTaskId?: string): SharedContextSnapshot {
    const activeTasks = [...this.tasks.values()]
      .filter((task) => task.taskId !== excludeTaskId)
      .filter((task) => task.status === 'queued' || task.status === 'running' || task.status === 'waiting_user' || task.status === 'blocked')
      .slice(0, 6)
      .map((task) => ({
        taskId: task.taskId,
        prompt: task.prompt,
        mode: task.mode,
        status: task.status,
        result: excerpt(task.result, 120),
        updatedAt: task.updatedAt,
      }));

    const recentTasks = [...this.tasks.values()]
      .filter((task) => task.taskId !== excludeTaskId)
      .filter((task) => task.status === 'completed' || task.status === 'failed')
      .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
      .slice(0, 6)
      .map((task) => ({
        taskId: task.taskId,
        prompt: task.prompt,
        mode: task.mode,
        status: task.status,
        result: excerpt(task.result, 120),
        updatedAt: task.updatedAt,
      }));

    return {
      summary: this.sharedSummary || 'No shared summary yet.',
      activeTasks,
      recentTasks,
    };
  }

  private createTask(
    userId: string,
    prompt: string,
    mode: TaskMode,
  ): PromptTask {
    const task: PromptTask = {
      traceId: telemetry.newTraceId(),
      taskId: randomUUID(),
      userId,
      prompt,
      mode,
      status: 'queued',
      plan: [],
      phaseEvents: [],
      messages: [],
      pendingClarifications: [],
      updatedAt: now(),
    };
    this.tasks.set(task.taskId, task);
    void this.persist(task);
    this.emit({ type: 'task_created', task: this.cloneTask(task), ts: now() });
    this.emitTaskUpdate(task);
    return task;
  }

  async acceptPrompt(
    userId: string,
    prompt: string,
    mode: TaskMode = 'execute',
    conversationHistory: ConversationEntry[] = [],
  ): Promise<string> {
    const task = this.createTask(userId, prompt, mode);
    this.taskHistory.set(task.taskId, [...conversationHistory]);
    setTimeout(() => {
      void this.runTask(task.taskId);
    }, 0);
    return task.taskId;
  }

  getTask(taskId: string): PromptTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): PromptTask[] {
    return [...this.tasks.values()];
  }

  async deleteTask(taskId: string): Promise<void> {
    this.tasks.delete(taskId);
    this.taskHistory.delete(taskId);
    await this.store.remove(taskId);
  }

  listSubagents(): SubAgentTask[] {
    return [...this.subagents.values()];
  }

  getSubagent(id: string): SubAgentTask | undefined {
    return this.subagents.get(id);
  }

  listPendingClarifications(taskId?: string): ClarificationRequest[] {
    const tasks = taskId ? [this.tasks.get(taskId)].filter(Boolean) as PromptTask[] : [...this.tasks.values()];
    return tasks.flatMap((task) => (task.pendingClarifications ?? []).filter((item) => item.status === 'pending'));
  }

  answerClarification(taskId: string, clarificationId: string, answer: string): boolean {
    const pending = this.clarifications.get(clarificationId);
    if (!pending || pending.taskId !== taskId) return false;

    const task = this.tasks.get(taskId);
    if (!task) return false;

    const request = task.pendingClarifications?.find((item) => item.clarificationId === clarificationId);
    if (!request) return false;

    request.status = 'answered';
    request.answer = answer;
    task.status = 'running';
    void this.persist(task);
    this.emit({
      type: 'clarification_answered',
      taskId,
      clarificationId,
      answer,
      ts: now(),
    });
    this.emitTaskUpdate(task);

    pending.resolve(answer);
    this.clarifications.delete(clarificationId);
    return true;
  }

  answerUser(taskId: string, answer: string): void {
    const request = this.listPendingClarifications(taskId)[0];
    if (request) {
      this.answerClarification(taskId, request.clarificationId, answer);
    }
  }

  async executePlan(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.mode !== 'plan' || task.plan.length === 0) return false;
    task.mode = 'execute';
    task.prompt = `Execute this approved plan:\n${task.plan.map((step) => `- ${step.title}: ${step.detail}`).join('\n')}`;
    task.status = 'queued';
    await this.persist(task);
    this.emitTaskUpdate(task);
    void this.runTask(taskId);
    return true;
  }

  async resolveTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'completed' || task.status === 'failed') return false;
    task.status = 'queued';
    await this.persist(task);
    this.emitTaskUpdate(task);
    setTimeout(() => {
      void this.runTask(taskId);
    }, 0);
    return true;
  }

  async spawnSubagent(prompt: string, parentTaskId = '', readOnly = false): Promise<string> {
    const subId = randomUUID();
    const sub: SubAgentTask = {
      taskId: subId,
      parentTaskId,
      prompt,
      status: 'queued',
      createdAt: now(),
      timeoutMs: 120_000,
      readOnly,
    };
    this.subagents.set(subId, sub);
    this.subagentManager.enqueue(sub);
    this.pumpSubagents();
    return subId;
  }

  async collectSubagent(subId: string): Promise<string> {
    const sub = this.subagents.get(subId);
    if (!sub) return `Error: subagent "${subId}" not found`;
    if (sub.status === 'queued' || sub.status === 'running') {
      return `SubagentStatus: ${sub.status}; id=${subId.slice(0, 8)}; createdAt=${sub.createdAt}`;
    }
    return sub.result ?? `Subagent ${subId.slice(0, 8)} completed with no result`;
  }

  private pumpSubagents(): void {
    while (this.subagentManager.canStart()) {
      const id = this.subagentManager.next();
      if (id) void this.runSubagent(id);
    }
  }

  private async runSubagent(subId: string): Promise<void> {
    const sub = this.subagents.get(subId);
    if (!sub) return;

    sub.status = 'running';
    sub.startedAt = now();
    const taskPolicy = sub.readOnly ? readOnlyPolicy(this.basePolicy) : this.basePolicy;
    const toolCtx: ToolContext = {
      spawnSubagent: async () => 'Error: subagents cannot spawn other subagents',
      collectSubagent: async () => 'Error: subagents cannot collect siblings directly',
      requestClarification: (question) => this.requestClarification(sub.parentTaskId || sub.taskId, question),
      acquireWriteLock: (path) => this.fileLocks.acquire(path),
      policy: taskPolicy,
      taskId: sub.parentTaskId || sub.taskId,
    };

    const tools = this.getToolsForTask(Boolean(sub.readOnly));
    const startedAt = Date.now();
    const timeoutMs = sub.timeoutMs ?? 120_000;

    try {
      const messages: OllamaMsg[] = [{ role: 'user', content: sub.prompt }];
      let result = '';
      for (let turn = 0; turn < 20; turn += 1) {
        if (Date.now() - startedAt > timeoutMs) throw new Error('subagent timeout');
        const { text, toolCalls } = await this.callModelWithTools(SUBAGENT_SYSTEM_PROMPT, messages, tools);
        const message: OllamaMsg = { role: 'assistant', content: text || null };
        if (toolCalls?.length) message.tool_calls = toolCalls;
        messages.push(message);
        result += `${text}\n`;
        if (!toolCalls?.length) break;
        for (const call of toolCalls) {
          const output = await executeTool(call.function.name, call.function.arguments, toolCtx);
          messages.push({ role: 'tool', content: output, tool_use_id: call.id });
        }
      }
      sub.result = result.trim();
      sub.status = 'completed';
      sub.completedAt = now();
    } catch (error) {
      sub.status = 'failed';
      sub.errorType = String(error).includes('timeout') ? 'timeout' : 'model_error';
      sub.result = `Subagent failed: ${String(error)}`;
      sub.completedAt = now();
    } finally {
      this.subagentManager.done(subId);
      this.pumpSubagents();
    }
  }

  async *streamPrompt(
    userId: string,
    prompt: string,
    mode: TaskMode = 'execute',
    conversationHistory: ConversationEntry[] = [],
  ): AsyncGenerator<StreamChunk> {
    const task = this.createTask(userId, prompt, mode);
    this.taskHistory.set(task.taskId, [...conversationHistory]);
    yield { type: 'task_id', taskId: task.taskId };
    yield* this.runTaskStream(task, conversationHistory);
  }

  private async runTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    const conversationHistory = this.taskHistory.get(taskId) ?? [];
    task.status = 'running';
    task.startedAt ??= now();
    await this.persist(task);
    this.emitTaskUpdate(task);

    try {
      for await (const chunk of this.runTaskStream(task, conversationHistory)) {
        switch (chunk.type) {
          case 'token':
            this.emit({ type: 'task_output', taskId: task.taskId, text: chunk.text, ts: now() });
            break;
          case 'phase':
            this.emit({
              type: 'task_phase',
              taskId: task.taskId,
              phase: chunk.phase,
              status: chunk.status,
              note: chunk.note,
              ts: now(),
            });
            break;
          case 'tool_call':
            this.emit({ type: 'tool_call', taskId: task.taskId, tool: chunk.tool, input: chunk.input, ts: now() });
            break;
          case 'tool_result':
            this.emit({ type: 'tool_result', taskId: task.taskId, tool: chunk.tool, output: chunk.output, ts: now() });
            break;
          case 'done':
            this.emit({ type: 'task_done', taskId: task.taskId, result: chunk.result, status: 'completed', ts: now() });
            break;
          case 'error':
            this.emit({ type: 'task_done', taskId: task.taskId, result: chunk.message, status: 'failed', ts: now() });
            break;
          default:
            break;
        }
      }
    } finally {
      if (['completed', 'failed'].includes(task.status)) {
        this.rememberTask(task);
      }
      this.emitTaskUpdate(task);
    }
  }

  private async requestClarification(taskId: string, question: string): Promise<string> {
    const task = this.tasks.get(taskId);
    if (!task) return '';

    const clarificationId = randomUUID();
    const request: ClarificationRequest = {
      clarificationId,
      taskId,
      question,
      createdAt: now(),
      status: 'pending',
    };
    task.pendingClarifications = [...(task.pendingClarifications ?? []), request];
    task.status = 'waiting_user';
    await this.persist(task);
    this.emit({
      type: 'clarification_requested',
      taskId,
      clarification: request,
      ts: now(),
    });
    this.emitTaskUpdate(task);

    return new Promise((resolve) => {
      this.clarifications.set(clarificationId, {
        taskId,
        resolve: (answer) => {
          resolve(answer);
        },
      });
    });
  }

  private async *runTaskStream(
    task: PromptTask,
    conversationHistory: ConversationEntry[],
  ): AsyncGenerator<StreamChunk> {
    try {
      task.sharedContext = renderSharedContext(this.buildSharedSnapshot(task.taskId));
      const planner = await this.planTask(task, conversationHistory);
      task.planner = planner;
      task.summary = planner.summary;
      task.readOnly = planner.readOnly;
      await this.persist(task);

      if (planner.questions[0]) {
        const answer = await this.requestClarification(task.taskId, planner.questions[0]);
        task.prompt = `${task.prompt}\n\nClarification from user:\n${answer}`;
        task.sharedContext = renderSharedContext(this.buildSharedSnapshot(task.taskId));
        await this.persist(task);
      }

      if (task.mode === 'plan') {
        this.markPhase(task, 'plan', 'in_progress', 'Generating execution plan…');
        yield { type: 'phase', phase: 'plan', status: 'in_progress', note: 'Generating execution plan…' };
        const content = await this.callModelText(
          `${task.sharedContext}\n\nUser request:\n${task.prompt}`,
          PLAN_SYSTEM_PROMPT,
          conversationHistory,
        );
        task.plan = await this.parsePlanWithRetry(content, task.prompt);
        task.status = 'blocked';
        const planText = task.plan.map((step, index) => `**${index + 1}. ${step.title}**\n${step.detail}`).join('\n\n');
        task.result = planText;
        await this.persist(task);
        this.markPhase(task, 'plan', 'done', `${task.plan.length} steps`);
        yield { type: 'phase', phase: 'plan', status: 'done', note: `${task.plan.length} steps` };
        yield { type: 'token', text: planText };
        yield { type: 'done', result: planText };
        return;
      }

      const route = (await this.callModelText(task.prompt, ROUTER_SYSTEM_PROMPT, conversationHistory)).trim().toUpperCase();
      const treatAsRepoAnalysis = task.readOnly || isRepoScopedPrompt(task.prompt);

      if (route === 'CHAT' && !treatAsRepoAnalysis) {
        this.markPhase(task, 'finalize', 'in_progress', 'Answering directly…');
        yield { type: 'phase', phase: 'finalize', status: 'in_progress', note: 'Answering directly…' };
        const quick = await this.callModelText(task.prompt, CHAT_SYSTEM_PROMPT, conversationHistory);
        task.result = quick;
        task.status = 'completed';
        task.completedAt = now();
        await this.persist(task);
        this.markPhase(task, 'finalize', 'done');
        yield { type: 'token', text: quick };
        yield { type: 'phase', phase: 'finalize', status: 'done' };
        yield { type: 'done', result: quick };
        return;
      }

      const toolCtx = this.createToolContext(task);

      if (task.mode === 'react') {
        yield* this.streamReactFlow(task, conversationHistory, toolCtx);
        return;
      }

      if (task.readOnly) {
        yield* this.streamReadOnlyFlow(task, conversationHistory, toolCtx);
        return;
      }

      const contextualPrompt = `${task.sharedContext}\n\nUser request:\n${task.prompt}`;
      const messages: OllamaMsg[] = [
        ...conversationHistory.map((entry) => ({ role: entry.role, content: entry.content })),
        { role: 'user', content: contextualPrompt },
      ];
      let fullResult = '';
      const maxTurns = 20;

      this.markPhase(task, 'design', 'in_progress', 'Exploring codebase and designing…');
      yield { type: 'phase', phase: 'design', status: 'in_progress', note: 'Exploring codebase and designing…' };
      const designResult = await this.runToolLoopStream(
        [...messages, { role: 'user', content: DESIGN_TOOLS_PROMPT }],
        maxTurns,
        toolCtx,
        task.readOnly ?? false,
      );
      messages.push({ role: 'assistant', content: `## Design\n${designResult}` });
      task.designDoc = designResult;
      fullResult += `## Design\n${designResult}\n\n`;
      await this.persist(task);
      this.markPhase(task, 'design', 'done');
      yield { type: 'token', text: `## Design\n${designResult}\n\n` };
      yield { type: 'phase', phase: 'design', status: 'done' };

      this.markPhase(task, 'write_code', 'in_progress', 'Writing implementation…');
      yield { type: 'phase', phase: 'write_code', status: 'in_progress', note: 'Writing implementation…' };
      let filesWritten = false;
      const implementationResult = await this.runToolLoopStream(
        messages,
        maxTurns,
        toolCtx,
        task.readOnly ?? false,
        (toolName) => {
          if (toolName === 'write_file' || toolName === 'edit_file') {
            filesWritten = true;
          }
        },
      );
      fullResult += implementationResult;
      task.messages = [...messages];
      await this.persist(task);
      this.markPhase(task, 'write_code', 'done');
      yield { type: 'token', text: implementationResult };
      yield { type: 'phase', phase: 'write_code', status: 'done' };

      if (filesWritten) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          this.markPhase(task, 'verify', 'in_progress', `Verifying (attempt ${attempt + 1})…`);
          yield { type: 'phase', phase: 'verify', status: 'in_progress', note: `Verifying (attempt ${attempt + 1})…` };
          const verifyResult = await this.runToolLoopStream(
            [...messages, { role: 'user', content: VERIFY_SELFIE_PROMPT }],
            maxTurns,
            toolCtx,
            false,
          );
          messages.push({ role: 'assistant', content: verifyResult || null });
          fullResult += `\n${verifyResult}`;
          task.messages = [...messages];
          await this.persist(task);
          yield { type: 'token', text: `\n${verifyResult}` };

          const lower = verifyResult.toLowerCase();
          const passed = !/fail|error|traceback|exited with code/i.test(lower)
            && (lower.includes('ok') || lower.includes('passed') || lower.includes('✓'));
          if (passed) {
            this.markPhase(task, 'verify', 'done', 'All checks passed');
            yield { type: 'phase', phase: 'verify', status: 'done', note: 'All checks passed' };
            break;
          }
          if (attempt === 2) {
            this.markPhase(task, 'verify', 'done', 'Max retries reached');
            yield { type: 'phase', phase: 'verify', status: 'done', note: 'Max retries reached' };
          }
        }
      }

      task.messages = messages;
      task.result = fullResult;
      task.status = 'completed';
      task.completedAt = now();
      await this.persist(task);
      yield { type: 'done', result: fullResult };
    } catch (error) {
      task.status = 'failed';
      task.result = `Error: ${String(error)}`;
      task.completedAt = now();
      await this.persist(task);
      yield { type: 'error', message: task.result };
    }
  }

  private async *streamReadOnlyFlow(
    task: PromptTask,
    conversationHistory: ConversationEntry[],
    toolCtx: ToolContext,
  ): AsyncGenerator<StreamChunk> {
    this.markPhase(task, 'inspect_code', 'in_progress', 'Inspecting repository…');
    yield { type: 'phase', phase: 'inspect_code', status: 'in_progress', note: 'Inspecting repository…' };
    const messages: OllamaMsg[] = [
      ...conversationHistory.map((entry) => ({ role: entry.role, content: entry.content })),
      {
        role: 'user',
        content: `${task.sharedContext}\n\nUser request:\n${task.prompt}\n\nInspect the repository and answer the request. Use repo_map, list_dir, read_file, bash, and load_skill as needed. Do not modify files.`,
      },
    ];
    const result = await this.runToolLoopStream(messages, 20, toolCtx, true);
    task.result = result;
    task.status = 'completed';
    task.completedAt = now();
    await this.persist(task);
    this.markPhase(task, 'inspect_code', 'done');
    yield { type: 'token', text: result };
    yield { type: 'phase', phase: 'inspect_code', status: 'done' };
    yield { type: 'done', result };
  }

  private async planTask(
    task: PromptTask,
    conversationHistory: ConversationEntry[],
  ): Promise<PlannerDecision> {
    const sharedContext = renderSharedContext(this.buildSharedSnapshot(task.taskId));
    const prompt = `${sharedContext}\n\nUser request:\n${task.prompt}`;
    try {
      const content = await this.callModelText(prompt, PLANNER_SYSTEM_PROMPT, conversationHistory);
      return parsePlannerDecision(content, task.prompt);
    } catch {
      return fallbackPlannerDecision(task.prompt);
    }
  }

  private createToolContext(task: PromptTask): ToolContext {
    const policy = task.readOnly ? readOnlyPolicy(this.basePolicy) : this.basePolicy;
    return {
      spawnSubagent: (prompt) => this.spawnSubagent(prompt, task.taskId, Boolean(task.readOnly)),
      collectSubagent: (id) => this.collectSubagent(id),
      requestClarification: (question) => this.requestClarification(task.taskId, question),
      acquireWriteLock: (path) => this.fileLocks.acquire(path),
      policy,
      sharedContext: task.sharedContext,
      taskId: task.taskId,
    };
  }

  private getToolsForTask(readOnly: boolean) {
    if (!readOnly) return WORKER_TOOLS;
    const blocked = new Set(['write_file', 'edit_file']);
    return WORKER_TOOLS.filter((tool) => !blocked.has(tool.function.name));
  }

  private markPhase(task: PromptTask, phase: TaskPhase, status: PhaseEvent['status'], note?: string): void {
    task.phaseEvents.push({ phase, status, note, ts: now() });
    telemetry.add({
      traceId: task.traceId ?? task.taskId,
      taskId: task.taskId,
      type: status === 'in_progress' ? 'phase_started' : 'phase_done',
      note: `${phase}:${status}${note ? `:${note}` : ''}`,
    });
    void this.persist(task);
  }

  private async parsePlanWithRetry(content: string, originalPrompt: string): Promise<PlanStep[]> {
    try {
      return parsePlan(content);
    } catch {
      const repaired = await this.callModelText(
        `${originalPrompt}\n\nYour previous output was invalid JSON. Return ONLY a JSON array with {"title","detail"}.`,
        PLAN_SYSTEM_PROMPT,
        [],
      );
      return parsePlan(repaired);
    }
  }

  private async *streamReactFlow(
    task: PromptTask,
    history: ConversationEntry[],
    toolCtx: ToolContext,
  ): AsyncGenerator<StreamChunk> {
    this.markPhase(task, 'plan', 'in_progress', 'Building plan…');
    yield { type: 'phase', phase: 'plan', status: 'in_progress', note: 'Building plan…' };
    const planContent = await this.callModelText(task.prompt, PLAN_SYSTEM_PROMPT, []);
    task.plan = await this.parsePlanWithRetry(planContent, task.prompt);
    this.markPhase(task, 'plan', 'done', `${task.plan.length} steps`);
    yield { type: 'phase', phase: 'plan', status: 'done', note: `${task.plan.length} steps` };
    const planMarkdown = task.plan.map((step, index) => `${index + 1}. **${step.title}** — ${step.detail}`).join('\n');
    yield { type: 'token', text: `## Plan\n${planMarkdown}\n\n` };

    this.markPhase(task, 'design', 'in_progress', 'Exploring + designing…');
    yield { type: 'phase', phase: 'design', status: 'in_progress', note: 'Exploring + designing…' };
    yield { type: 'token', text: '## Design\n' };
    const designMessages: OllamaMsg[] = [
      ...history.map((entry) => ({ role: entry.role, content: entry.content })),
      { role: 'user', content: `Shared context:\n${task.sharedContext ?? ''}\n\nPlan:\n${planMarkdown}\n\n${DESIGN_TOOLS_PROMPT}` },
    ];
    let designText = '';
    for await (const _chunk of this.agenticStreamRaw(designMessages, toolCtx, task.readOnly ?? false, (text) => {
      designText += text;
    })) {
      // tokens already captured through callback
    }
    task.designDoc = designText;
    await this.persist(task);
    yield { type: 'token', text: `${designText}\n\n` };
    this.markPhase(task, 'design', 'done');
    yield { type: 'phase', phase: 'design', status: 'done' };

    this.markPhase(task, 'inspect_code', 'in_progress', 'Analyzing codebase…');
    yield { type: 'phase', phase: 'inspect_code', status: 'in_progress', note: 'Analyzing codebase…' };
    yield { type: 'token', text: '## Analysis\n' };
    let inspectResult = '';
    yield* this.agenticStream(REACT_INSPECT_PROMPT(planMarkdown), history, toolCtx, task.readOnly ?? false, (text) => {
      inspectResult += text;
    });
    this.markPhase(task, 'inspect_code', 'done');
    yield { type: 'phase', phase: 'inspect_code', status: 'done' };

    this.markPhase(task, 'write_code', 'in_progress', 'Writing implementation…');
    yield { type: 'phase', phase: 'write_code', status: 'in_progress', note: 'Writing implementation…' };
    yield { type: 'token', text: '\n\n## Implementation\n' };
    let implementation = '';
    yield* this.agenticStream(
      REACT_IMPLEMENT_PROMPT(planMarkdown, `${designText}\n${inspectResult}`),
      history,
      toolCtx,
      task.readOnly ?? false,
      (text) => {
        implementation += text;
      },
    );
    this.markPhase(task, 'write_code', 'done');
    yield { type: 'phase', phase: 'write_code', status: 'done' };

    this.markPhase(task, 'verify', 'in_progress', 'Verifying…');
    yield { type: 'phase', phase: 'verify', status: 'in_progress', note: 'Verifying…' };
    yield { type: 'token', text: '\n\n## Verification\n' };
    let verify = '';
    yield* this.agenticStream(REACT_VERIFY_PROMPT(implementation), history, toolCtx, false, (text) => {
      verify += text;
    });
    this.markPhase(task, 'verify', 'done');
    yield { type: 'phase', phase: 'verify', status: 'done' };

    const fullResult = `## Plan\n${planMarkdown}\n\n## Design\n${designText}\n\n## Analysis\n${inspectResult}\n\n## Implementation\n${implementation}\n\n## Verification\n${verify}`;
    task.result = fullResult;
    task.status = 'completed';
    task.completedAt = now();
    await this.persist(task);
    yield { type: 'done', result: fullResult };
  }

  private async *agenticStreamRaw(
    messages: OllamaMsg[],
    toolCtx: ToolContext,
    readOnly: boolean,
    onText: (text: string) => void,
  ): AsyncGenerator<StreamChunk> {
    const tools = this.getToolsForTask(readOnly);
    for (let turn = 0; turn < 20; turn += 1) {
      let assistantText = '';
      let toolCalls: OllamaMsg['tool_calls'];

      for await (const chunk of this.streamModelWithTools(EXECUTE_SYSTEM_PROMPT, messages, tools)) {
        if (chunk.message?.content) {
          assistantText += chunk.message.content;
          onText(chunk.message.content);
          yield { type: 'token', text: chunk.message.content };
        }
        if (chunk.message?.tool_calls?.length) {
          toolCalls = chunk.message.tool_calls;
        }
      }

      const message: OllamaMsg = { role: 'assistant', content: assistantText || null };
      if (toolCalls?.length) message.tool_calls = toolCalls;
      messages.push(message);

      if (!toolCalls?.length) break;

      for (const call of toolCalls) {
        const toolName = call.function.name;
        const toolArgs = call.function.arguments;
        const preview = toolArgs['command'] ?? toolArgs['path'] ?? JSON.stringify(toolArgs);
        yield { type: 'tool_call', tool: toolName, input: preview };

        if (toolName === 'request_clarification' || toolName === 'ask_user') {
          yield { type: 'ask_user', question: toolArgs['question'] ?? '' };
        }

        const result = await executeTool(toolName, toolArgs, toolCtx);
        yield { type: 'tool_result', tool: toolName, output: result };
        messages.push({ role: 'tool', content: result, tool_use_id: call.id });
      }
    }
  }

  private async *agenticStream(
    userPrompt: string,
    baseHistory: ConversationEntry[],
    toolCtx: ToolContext,
    readOnly: boolean,
    onText: (text: string) => void,
  ): AsyncGenerator<StreamChunk> {
    const messages: OllamaMsg[] = [
      ...baseHistory.map((entry) => ({ role: entry.role, content: entry.content })),
      { role: 'user', content: userPrompt },
    ];
    yield* this.agenticStreamRaw(messages, toolCtx, readOnly, onText);
  }

  private async runToolLoopStream(
    messages: OllamaMsg[],
    maxTurns: number,
    toolCtx: ToolContext,
    readOnly: boolean,
    onToolCall?: (tool: string) => void,
  ): Promise<string> {
    const tools = this.getToolsForTask(readOnly);
    let fullResult = '';
    for (let turn = 0; turn < maxTurns; turn += 1) {
      let assistantText = '';
      let toolCalls: OllamaMsg['tool_calls'];

      for await (const chunk of this.streamModelWithTools(EXECUTE_SYSTEM_PROMPT, messages, tools)) {
        if (chunk.message?.content) assistantText += chunk.message.content;
        if (chunk.message?.tool_calls?.length) toolCalls = chunk.message.tool_calls;
      }

      const message: OllamaMsg = { role: 'assistant', content: assistantText || null };
      if (toolCalls?.length) message.tool_calls = toolCalls;
      messages.push(message);
      fullResult += `${assistantText}\n`;

      if (!toolCalls?.length) break;

      for (const call of toolCalls) {
        onToolCall?.(call.function.name);
        const result = await executeTool(call.function.name, call.function.arguments, toolCtx);
        messages.push({ role: 'tool', content: result, tool_use_id: call.id });
      }
    }
    return fullResult.trim();
  }

  private async *streamModelWithTools(
    systemPrompt: string,
    messages: OllamaMsg[],
    tools = WORKER_TOOLS,
  ): AsyncGenerator<OllamaStreamChunk> {
    for await (const chunk of chatStream(this.backend, systemPrompt, messages, tools)) {
      const output: OllamaStreamChunk = {};
      if (chunk.content !== null) {
        output.message = { role: 'assistant', content: chunk.content };
      }
      if (chunk.toolCalls) {
        output.message = {
          ...output.message,
          role: 'assistant',
          content: output.message?.content ?? null,
          tool_calls: chunk.toolCalls,
        };
      }
      if (chunk.done) output.done = true;
      if (output.message || output.done) yield output;
    }
  }

  private async callModelWithTools(
    systemPrompt: string,
    messages: OllamaMsg[],
    tools = WORKER_TOOLS,
  ): Promise<{ text: string; toolCalls: OllamaMsg['tool_calls'] }> {
    const cacheKey = JSON.stringify({
      systemPrompt,
      messages,
      tools: tools.map((tool) => tool.function.name),
    });
    const cached = this.cache.get(this.backend.model, systemPrompt, cacheKey);
    if (cached) return JSON.parse(cached) as { text: string; toolCalls: OllamaMsg['tool_calls'] };

    let text = '';
    let toolCalls: OllamaMsg['tool_calls'];
    for await (const chunk of this.streamModelWithTools(systemPrompt, messages, tools)) {
      if (chunk.message?.content) text += chunk.message.content;
      if (chunk.message?.tool_calls?.length) toolCalls = chunk.message.tool_calls;
    }

    const result = { text: text.trim(), toolCalls };
    this.cache.set(this.backend.model, systemPrompt, cacheKey, JSON.stringify(result));
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
    history: ConversationEntry[],
  ): Promise<string> {
    const messages: OllamaMsg[] = [
      ...history.map((entry) => ({ role: entry.role, content: entry.content })),
      ...(userPrompt ? [{ role: 'user', content: userPrompt }] : []),
    ];

    const cacheKey = JSON.stringify(messages);
    const cached = this.cache.get(this.backend.model, systemPrompt, cacheKey);
    if (cached) return cached;

    let full = '';
    for await (const chunk of this.streamModelText(systemPrompt, messages)) {
      full += chunk;
    }
    const result = full.trim();
    this.cache.set(this.backend.model, systemPrompt, cacheKey, result);
    return result;
  }
}

export { parseOllamaNdjson, parsePlan };
