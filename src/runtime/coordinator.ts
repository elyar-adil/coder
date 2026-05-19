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
  MASTER_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  REACT_IMPLEMENT_PROMPT,
  REACT_INSPECT_PROMPT,
  REACT_VERIFY_PROMPT,
  ROUTER_SYSTEM_PROMPT,
  STEP_EXECUTOR_SYSTEM_PROMPT,
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

function needsRepositoryInspection(prompt: string): boolean {
  return /\b(repo|repository|codebase|project|module|function|file|src|test|bug|build|implementation|stack trace|error|failing|failure|refactor|architecture)\b/i.test(prompt);
}

function parseClarificationChoices(content: string): string[] {
  try {
    const trimmed = content.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced?.[1] ?? trimmed).trim();
    const parsed = JSON.parse(candidate) as Array<{ label?: string; value?: string } | string>;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
      if (typeof item === 'string') return item.trim();
      const label = typeof item?.label === 'string' ? item.label.trim() : '';
      const value = typeof item?.value === 'string' ? item.value.trim() : '';
      return label || value;
    }).filter(Boolean).slice(0, 4);
  } catch {
    return [];
  }
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
  private llmTracingEnabled = false;

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

  getBackendConfig(): BackendConfig {
    return { ...this.backend, requestOptions: this.backend.requestOptions ? { ...this.backend.requestOptions } : undefined };
  }

  setBackendConfig(config: BackendConfig): void {
    this.backend = config;
  }

  setLlmTracingEnabled(enabled: boolean): void {
    this.llmTracingEnabled = enabled;
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
      llmTrace: task.llmTrace ? task.llmTrace.map((entry) => ({
        ...entry,
        messages: entry.messages.map((message) => ({ ...message })),
        toolCalls: entry.toolCalls ? [...entry.toolCalls] : undefined,
      })) : undefined,
      pendingClarifications: task.pendingClarifications ? [...task.pendingClarifications] : undefined,
    };
  }

  private async persist(task: PromptTask): Promise<void> {
    task.updatedAt = now();
    await this.store.save(task);
  }

  private emitSubagentUpdate(subagent: SubAgentTask): void {
    this.emit({ type: 'subagent_updated', subagent: { ...subagent }, ts: now() });
  }

  private emitTaskUpdate(task: PromptTask): void {
    this.emit({ type: 'task_updated', task: this.cloneTask(task), ts: now() });
  }

  private rememberTask(task: PromptTask): void {
    const line = `${task.taskId.slice(0, 8)} [${task.status}] ${excerpt(task.summary ?? task.prompt, 120)}${task.result ? ` => ${excerpt(task.result, 140)}` : ''}`;
    const lines = [line, ...this.sharedSummary.split('\n').filter(Boolean)];
    this.sharedSummary = lines.slice(0, 8).join('\n');
  }

  private appendLlmTrace(
    taskId: string | undefined,
    label: string,
    systemPrompt: string,
    messages: OllamaMsg[],
    response: string,
    toolCalls?: OllamaMsg['tool_calls'],
    cached = false,
  ): void {
    if (!this.llmTracingEnabled) return;
    if (!taskId) return;
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.llmTrace = [
      ...(task.llmTrace ?? []),
      {
        ts: now(),
        label,
        systemPrompt,
        messages: messages.map((message) => ({
          ...message,
          tool_calls: message.tool_calls ? [...message.tool_calls] : undefined,
        })),
        response,
        toolCalls: toolCalls ? [...toolCalls] : undefined,
        cached,
      },
    ].slice(-50);
    void this.persist(task);
    this.emitTaskUpdate(task);
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
    this.emit({ type: 'subagent_created', subagent: { ...sub }, ts: now() });
    this.subagentManager.enqueue(sub);
    this.pumpSubagents();
    return subId;
  }

  private async waitForSubagent(subId: string, timeoutMs = 120_000): Promise<SubAgentTask | undefined> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const sub = this.subagents.get(subId);
      if (!sub) return undefined;
      if (sub.status === 'completed' || sub.status === 'failed') return sub;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return this.subagents.get(subId);
  }

  private async dispatchPlannerSubtasks(task: PromptTask, planner: PlannerDecision): Promise<void> {
    if (planner.subtasks.length === 0) return;

    const spawned = await Promise.all(planner.subtasks.map((step, index) => {
      const prompt = [
        `Parent task: ${task.prompt}`,
        `Subtask ${index + 1}: ${step.title}`,
        `Detail: ${step.detail}`,
        'Work independently, stay within scope, and report a concise result.',
      ].join('\n');
      return this.spawnSubagent(prompt, task.taskId, Boolean(task.readOnly));
    }));

    const results = await Promise.all(spawned.map((id) => this.waitForSubagent(id)));
    const notes = results
      .filter((sub): sub is SubAgentTask => Boolean(sub))
      .map((sub) => `- ${sub.taskId.slice(0, 8)} [${sub.status}] ${excerpt(sub.result ?? sub.prompt, 160)}`);

    if (notes.length > 0) {
      task.sharedContext = `${task.sharedContext ?? ''}\n\nWorker results:\n${notes.join('\n')}`.trim();
      await this.persist(task);
      this.emitTaskUpdate(task);
    }
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
    this.emitSubagentUpdate(sub);
    const taskPolicy = sub.readOnly ? readOnlyPolicy(this.basePolicy) : this.basePolicy;
    const toolCtx: ToolContext = {
      spawnSubagent: async () => 'Error: subagents cannot spawn other subagents',
      collectSubagent: async () => 'Error: subagents cannot collect siblings directly',
      requestClarification: (question, choices) => this.requestClarification(sub.parentTaskId || sub.taskId, question, choices),
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
        const { text, toolCalls } = await this.callModelWithTools(
          SUBAGENT_SYSTEM_PROMPT,
          messages,
          tools,
          sub.parentTaskId || sub.taskId,
          'subagent',
        );
        const message: OllamaMsg = { role: 'assistant', content: text || null };
        if (toolCalls?.length) message.tool_calls = toolCalls;
        messages.push(message);
        result += `${text}\n`;
        if (text.trim()) {
          this.emit({
            type: 'subagent_output',
            subagentId: sub.taskId,
            parentTaskId: sub.parentTaskId,
            text,
            ts: now(),
          });
        }
        if (!toolCalls?.length) break;
        for (const call of toolCalls) {
          const output = await executeTool(call.function.name, call.function.arguments, toolCtx);
          this.emit({
            type: 'subagent_output',
            subagentId: sub.taskId,
            parentTaskId: sub.parentTaskId,
            text: `[tool:${call.function.name}] ${excerpt(output, 240)}`,
            ts: now(),
          });
          messages.push({ role: 'tool', content: output, tool_use_id: call.id });
        }
      }
      sub.result = result.trim();
      sub.status = 'completed';
      sub.completedAt = now();
      this.emitSubagentUpdate(sub);
    } catch (error) {
      sub.status = 'failed';
      sub.errorType = String(error).includes('timeout') ? 'timeout' : 'model_error';
      sub.result = `Subagent failed: ${String(error)}`;
      sub.completedAt = now();
      this.emitSubagentUpdate(sub);
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

  private async requestClarification(taskId: string, question: string, choices: string[] = []): Promise<string> {
    const task = this.tasks.get(taskId);
    if (!task) return '';

    const clarificationId = randomUUID();
    let finalChoices = choices.slice(0, 4);
    if (finalChoices.length === 0) {
      const prompt = [
        `Task: ${task.prompt}`,
        `Question: ${question}`,
        task.sharedContext ? `Shared context:\n${task.sharedContext}` : '',
        '',
        'Generate 2 to 4 concrete answer choices for the user.',
        'Rules:',
        '- Return ONLY valid JSON array.',
        '- Each item must have "label" and "value" strings.',
        '- Choices must be specific and useful, not yes/no or generic.',
        '- Keep labels short and distinct.',
      ].filter(Boolean).join('\n');
      const content = await this.callModelText(prompt, MASTER_SYSTEM_PROMPT, [], task, 'clarification_choices');
      finalChoices = parseClarificationChoices(content);
      if (finalChoices.length === 0) {
        finalChoices = [question];
      }
    }
    const request: ClarificationRequest = {
      clarificationId,
      taskId,
      question,
      choices: finalChoices,
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
      this.markPhase(task, 'plan', 'in_progress', 'Planning next steps…');
      yield { type: 'phase', phase: 'plan', status: 'in_progress', note: 'Planning next steps…' };
      const planner = await this.planTask(task, conversationHistory);
      task.planner = planner;
      task.summary = planner.summary;
      task.readOnly = planner.readOnly;
      task.plan = planner.steps;
      await this.persist(task);
      this.markPhase(task, 'plan', 'done', `${planner.steps.length} step${planner.steps.length === 1 ? '' : 's'}`);
      yield { type: 'phase', phase: 'plan', status: 'done', note: `${planner.steps.length} step${planner.steps.length === 1 ? '' : 's'}` };

      if (planner.questions[0]) {
        const answer = await this.requestClarification(task.taskId, planner.questions[0]);
        task.prompt = `${task.prompt}\n\nClarification from user:\n${answer}`;
        task.sharedContext = renderSharedContext(this.buildSharedSnapshot(task.taskId));
        await this.persist(task);
      }

      if (task.mode === 'plan') {
        task.status = 'blocked';
        const planText = this.renderPlanMarkdown(planner.steps);
        task.result = planText;
        await this.persist(task);
        yield { type: 'token', text: planText };
        yield { type: 'done', result: planText };
        return;
      }

      const toolCtx = this.createToolContext(task);
      const fullResult = yield* this.streamPlannerDrivenFlow(task, conversationHistory, toolCtx, planner.steps);
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
    let result = '';
    for await (const chunk of this.runToolLoopStream(messages, 20, toolCtx, true, 'read_only', (text) => {
      result += text;
    })) {
      yield chunk;
    }
    result = result.trim();
    task.result = result;
    task.status = 'completed';
    task.completedAt = now();
    await this.persist(task);
    this.markPhase(task, 'inspect_code', 'done');
    yield { type: 'token', text: result };
    yield { type: 'phase', phase: 'inspect_code', status: 'done' };
    yield { type: 'done', result };
  }

  private async *streamPlannerDrivenFlow(
    task: PromptTask,
    conversationHistory: ConversationEntry[],
    toolCtx: ToolContext,
    steps: PlanStep[],
  ): AsyncGenerator<StreamChunk, string> {
    const results: string[] = [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]!;
      const phase = this.phaseForStep(step);
      const note = `${index + 1}/${steps.length}: ${step.title}`;
      this.markPhase(task, phase, 'in_progress', note);
      yield { type: 'phase', phase, status: 'in_progress', note };
      const heading = `## ${step.title}\n`;
      yield { type: 'token', text: heading };

      const result = yield* this.executePlannerStep(task, conversationHistory, toolCtx, step, index);
      const trimmed = result.trim();
      if (trimmed) {
        results.push(`## ${step.title}\n${trimmed}`);
        if (step.intent === 'answer' || step.intent === 'ask_user') {
          yield { type: 'token', text: `${trimmed}\n\n` };
        } else {
          yield { type: 'token', text: '\n\n' };
        }
      }
      this.markPhase(task, phase, 'done', step.title);
      yield { type: 'phase', phase, status: 'done', note: step.title };
    }
    return results.join('\n\n').trim();
  }

  private async *executePlannerStep(
    task: PromptTask,
    conversationHistory: ConversationEntry[],
    toolCtx: ToolContext,
    step: PlanStep,
    index: number,
  ): AsyncGenerator<StreamChunk, string> {
    const intent = step.intent ?? 'answer';
    const instruction = step.instruction || step.detail || step.title;
    if (intent === 'ask_user') {
      return this.requestClarification(task.taskId, instruction);
    }

    if (intent === 'answer') {
      return await this.callModelText(
        [
          task.sharedContext ? `Shared context:\n${task.sharedContext}` : '',
          `User request:\n${task.prompt}`,
          `Current step:\n${instruction}`,
          'Answer this step directly and concisely.',
        ].filter(Boolean).join('\n\n'),
        CHAT_SYSTEM_PROMPT,
        conversationHistory,
        task,
        `step_${index + 1}_answer`,
      );
    }

    const messages: OllamaMsg[] = [
      ...conversationHistory.map((entry) => ({ role: entry.role, content: entry.content })),
      {
        role: 'user',
        content: [
          task.sharedContext ? `Shared context:\n${task.sharedContext}` : '',
          `User request:\n${task.prompt}`,
          `Current planner step: ${step.title}`,
          `Intent: ${intent}`,
          `Instruction:\n${instruction}`,
          '',
          'Execute only this planner step. Return a concise result for this step.',
        ].filter(Boolean).join('\n\n'),
      },
    ];
    let result = '';
    for await (const chunk of this.runToolLoopStream(
      messages,
      10,
      toolCtx,
      step.toolPolicy === 'read_only' || step.toolPolicy === 'safe',
      `step_${index + 1}_${intent}`,
      (text) => {
        result += text;
      },
      undefined,
      this.getToolsForStep(step),
      STEP_EXECUTOR_SYSTEM_PROMPT,
    )) {
      yield chunk;
    }
    return result;
  }

  private renderPlanMarkdown(steps: PlanStep[]): string {
    return steps.map((step, index) => {
      const intent = step.intent ? ` (${step.intent})` : '';
      return `**${index + 1}. ${step.title}${intent}**\n${step.instruction || step.detail}`;
    }).join('\n\n');
  }

  private phaseForStep(step: PlanStep): TaskPhase {
    if (step.intent === 'code_change') return 'write_code';
    if (step.intent === 'verify') return 'verify';
    if (step.intent === 'answer') return 'finalize';
    return 'execute';
  }

  private getToolsForStep(step: PlanStep) {
    const names = (() => {
      switch (step.toolPolicy) {
        case 'none':
          return new Set<string>();
        case 'read_only':
          return new Set(['repo_map', 'read_file', 'list_dir', 'bash', 'load_skill', 'request_clarification']);
        case 'code_write':
          return new Set(WORKER_TOOLS.map((tool) => tool.function.name));
        case 'verify':
          return new Set(['read_file', 'edit_file', 'write_file', 'bash', 'request_clarification']);
        case 'safe':
        default:
          return new Set(['bash', 'request_clarification']);
      }
    })();
    return WORKER_TOOLS.filter((tool) => names.has(tool.function.name));
  }

  private async planTask(
    task: PromptTask,
    conversationHistory: ConversationEntry[],
  ): Promise<PlannerDecision> {
    const sharedContext = renderSharedContext(this.buildSharedSnapshot(task.taskId));
    const prompt = `${sharedContext}\n\nUser request:\n${task.prompt}`;
    try {
      const content = await this.callModelText(prompt, PLANNER_SYSTEM_PROMPT, conversationHistory, task, 'planner');
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
      requestClarification: (question, choices) => this.requestClarification(task.taskId, question, choices),
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
        undefined,
        'plan_repair',
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
    const planContent = await this.callModelText(task.prompt, PLAN_SYSTEM_PROMPT, [], task, 'react_plan');
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
    for await (const _chunk of this.agenticStreamRaw(designMessages, toolCtx, task.readOnly ?? false, 'react_design', (text) => {
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
    yield* this.agenticStream(REACT_INSPECT_PROMPT(planMarkdown), history, toolCtx, task.readOnly ?? false, 'react_inspect', (text) => {
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
      'react_implementation',
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
    yield* this.agenticStream(REACT_VERIFY_PROMPT(implementation), history, toolCtx, false, 'react_verify', (text) => {
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
    label: string,
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

      this.appendLlmTrace(toolCtx.taskId, label, EXECUTE_SYSTEM_PROMPT, messages, assistantText.trim(), toolCalls);

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
    label: string,
    onText: (text: string) => void,
  ): AsyncGenerator<StreamChunk> {
    const messages: OllamaMsg[] = [
      ...baseHistory.map((entry) => ({ role: entry.role, content: entry.content })),
      { role: 'user', content: userPrompt },
    ];
    yield* this.agenticStreamRaw(messages, toolCtx, readOnly, label, onText);
  }

  private async *runToolLoopStream(
    messages: OllamaMsg[],
    maxTurns: number,
    toolCtx: ToolContext,
    readOnly: boolean,
    label: string,
    onText?: (text: string) => void,
    onToolCall?: (tool: string) => void,
    toolsOverride?: typeof WORKER_TOOLS,
    systemPrompt = EXECUTE_SYSTEM_PROMPT,
  ): AsyncGenerator<StreamChunk> {
    const tools = toolsOverride ?? this.getToolsForTask(readOnly);
    for (let turn = 0; turn < maxTurns; turn += 1) {
      let assistantText = '';
      let toolCalls: OllamaMsg['tool_calls'];

      for await (const chunk of this.streamModelWithTools(systemPrompt, messages, tools)) {
        if (chunk.message?.content) {
          assistantText += chunk.message.content;
          onText?.(chunk.message.content);
          yield { type: 'token', text: chunk.message.content };
        }
        if (chunk.message?.tool_calls?.length) toolCalls = chunk.message.tool_calls;
      }

      this.appendLlmTrace(toolCtx.taskId, label, systemPrompt, messages, assistantText.trim(), toolCalls);

      const message: OllamaMsg = { role: 'assistant', content: assistantText || null };
      if (toolCalls?.length) message.tool_calls = toolCalls;
      messages.push(message);

      if (!toolCalls?.length) break;

      for (const call of toolCalls) {
        onToolCall?.(call.function.name);
        const toolName = call.function.name;
        const toolArgs = call.function.arguments;
        const preview = toolArgs['command'] ?? toolArgs['path'] ?? JSON.stringify(toolArgs);
        yield { type: 'tool_call', tool: toolName, input: preview };
        const result = await executeTool(call.function.name, call.function.arguments, toolCtx);
        yield { type: 'tool_result', tool: toolName, output: result };
        messages.push({ role: 'tool', content: result, tool_use_id: call.id });
      }
    }
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
    taskId?: string,
    label = 'model_tools',
  ): Promise<{ text: string; toolCalls: OllamaMsg['tool_calls'] }> {
    const cacheKey = JSON.stringify({
      systemPrompt,
      messages,
      tools: tools.map((tool) => tool.function.name),
    });
    const cached = this.cache.get(this.backend.model, systemPrompt, cacheKey);
    if (cached) {
      const result = JSON.parse(cached) as { text: string; toolCalls: OllamaMsg['tool_calls'] };
      this.appendLlmTrace(taskId, label, systemPrompt, messages, result.text, result.toolCalls, true);
      return result;
    }

    let text = '';
    let toolCalls: OllamaMsg['tool_calls'];
    for await (const chunk of this.streamModelWithTools(systemPrompt, messages, tools)) {
      if (chunk.message?.content) text += chunk.message.content;
      if (chunk.message?.tool_calls?.length) toolCalls = chunk.message.tool_calls;
    }

    const result = { text: text.trim(), toolCalls };
    this.appendLlmTrace(taskId, label, systemPrompt, messages, result.text, toolCalls);
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
    task?: PromptTask,
    label = 'model_text',
  ): Promise<string> {
    const messages: OllamaMsg[] = [
      ...history.map((entry) => ({ role: entry.role, content: entry.content })),
      ...(userPrompt ? [{ role: 'user', content: userPrompt }] : []),
    ];

    const cacheKey = JSON.stringify(messages);
    const cached = this.cache.get(this.backend.model, systemPrompt, cacheKey);
    if (cached) {
      this.appendLlmTrace(task?.taskId, label, systemPrompt, messages, cached, undefined, true);
      return cached;
    }

    let full = '';
    for await (const chunk of this.streamModelText(systemPrompt, messages)) {
      full += chunk;
    }
    const result = full.trim();
    this.appendLlmTrace(task?.taskId, label, systemPrompt, messages, result);
    this.cache.set(this.backend.model, systemPrompt, cacheKey, result);
    return result;
  }
}

export { parseOllamaNdjson, parsePlan };
