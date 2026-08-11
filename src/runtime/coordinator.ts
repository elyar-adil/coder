import { createHash, randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { BackendConfig } from '../backend.js';
import { chatStream } from '../backend.js';
import { unifiedDiff } from '../diff.js';
import type {
  ClarificationRequest,
  Goal,
  MasterEvent,
  OllamaMsg,
  PatchSet,
  PlanStep,
  PlannerDecision,
  PromptTask,
  SubAgentTask,
  TaskContextSnapshot,
  TaskKind,
  TaskMailboxMessage,
  TaskMode,
  TaskPhase,
  TodoItem,
  ToolContext,
} from '../domain/task.js';
import { clonePolicy, readOnlyPolicy } from '../policy.js';
import type { PhaseEvent } from '../domain/task.js';
import {
  CHAT_SYSTEM_PROMPT,
  AUTONOMOUS_SYSTEM_PROMPT,
  CONTEXT_SUMMARIZER_PROMPT,
  EXECUTE_SYSTEM_PROMPT,
  GOAL_VERIFIER_PROMPT,
  MASTER_QUERY_SYSTEM_PROMPT,
  MASTER_ROUTER_SYSTEM_PROMPT,
  MASTER_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  PRESENTATION_SYSTEM_PROMPT,
  STEP_EXECUTOR_SYSTEM_PROMPT,
  SUBAGENT_SYSTEM_PROMPT,
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
  type OllamaStreamChunk,
  type ParsedPlannerDecision,
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

type RouteAction = 'respond' | 'new_task' | 'query_task' | 'update_task' | 'derived_task' | 'sync_task' | 'clarify_target';

type RouteDecision = {
  action: RouteAction;
  targetTaskIds: string[];
  reason: string;
  prompt: string;
};

type PromptDispatchOptions = {
  sessionId?: string;
  artifactDir?: string;
};

type ListTaskOptions = {
  sessionId?: string;
};

const execAsync = promisify(exec);

function now(): string {
  return new Date().toISOString();
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function excerpt(value: string | undefined, max = 200): string {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function artifactContext(artifactDir?: string): string {
  if (!artifactDir) return '';
  return [
    'Artifact workspace:',
    `- Default session artifact directory: ${artifactDir}`,
    '- Save temporary deliverables there unless the user explicitly asks for another path or the task is editing repository code.',
    '- When the user should download a generated artifact, report it with [[download:/exact/path/to/file.ext]] or [[download:/exact/path/to/file.ext|file.ext]].',
    '- Do not use the download marker for ordinary repository/source paths; plain paths remain plain text.',
  ].join('\n');
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

function normalizeClarificationChoices(question: string, choices: string[] = []): string[] {
  const normalized: string[] = [];
  for (const choice of choices) {
    const text = choice.trim().replace(/\s+/g, ' ');
    if (text && !normalized.includes(text)) normalized.push(text);
  }

  const fallback = [
    'Proceed with the safest reasonable default',
    'Use the simplest implementation',
    'Stop this task and report what is missing',
    'Keep this task waiting for more context',
  ];
  for (const choice of fallback) {
    if (normalized.length >= 2) break;
    if (!normalized.includes(choice) && choice !== question.trim()) normalized.push(choice);
  }

  return normalized.slice(0, 4);
}

function isRouteAction(value: unknown): value is RouteAction {
  return value === 'respond'
    || value === 'new_task'
    || value === 'query_task'
    || value === 'update_task'
    || value === 'derived_task'
    || value === 'sync_task'
    || value === 'clarify_target';
}

function parseRouteDecision(content: string, prompt: string): RouteDecision {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const parsed = JSON.parse(candidate) as Partial<RouteDecision>;
  return {
    action: isRouteAction(parsed.action) ? parsed.action : 'new_task',
    targetTaskIds: Array.isArray(parsed.targetTaskIds)
      ? parsed.targetTaskIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [],
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : '',
    prompt: typeof parsed.prompt === 'string' && parsed.prompt.trim() ? parsed.prompt : prompt,
  };
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
  private sessionTaskIds = new Set<string>();
  private pendingRouteTasks = new Set<string>();
  private routingTasks = new Set<string>();
  private scheduledTaskRuns = new Set<string>();
  private runningTasks = new Set<string>();
  /** Cooperative cancellation: checked between model/tool turns. */
  private taskControllers = new Map<string, AbortController>();
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
      relatedTaskIds: task.relatedTaskIds ? [...task.relatedTaskIds] : undefined,
      mailbox: task.mailbox ? task.mailbox.map((message) => ({ ...message })) : undefined,
      messages: task.messages ? [...task.messages] : undefined,
      llmTrace: task.llmTrace ? task.llmTrace.map((entry) => ({
        ...entry,
        messages: entry.messages.map((message) => ({ ...message })),
        toolCalls: entry.toolCalls ? [...entry.toolCalls] : undefined,
      })) : undefined,
      pendingClarifications: task.pendingClarifications ? [...task.pendingClarifications] : undefined,
      artifactDir: task.artifactDir,
      visibleMessages: task.visibleMessages ? task.visibleMessages.map((message) => ({ ...message })) : undefined,
      debugEvents: task.debugEvents ? task.debugEvents.map((event) => ({ ...event })) : undefined,
      patchSets: task.patchSets ? task.patchSets.map((patch) => ({
        ...patch,
        files: patch.files.map((file) => ({ ...file })),
        verificationCommands: [...patch.verificationCommands],
        conflicts: patch.conflicts ? patch.conflicts.map((conflict) => ({ ...conflict })) : undefined,
      })) : undefined,
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

  private enqueueTaskRun(taskId: string): void {
    if (this.pendingRouteTasks.has(taskId) || this.routingTasks.has(taskId) || this.runningTasks.has(taskId) || this.scheduledTaskRuns.has(taskId)) return;
    this.scheduledTaskRuns.add(taskId);
    setTimeout(() => {
      this.scheduledTaskRuns.delete(taskId);
      void this.runTask(taskId);
    }, 0);
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

  private buildTaskContextSnapshot(task: PromptTask): TaskContextSnapshot {
    const lastPhase = task.phaseEvents.at(-1);
    const pendingUpdates = (task.mailbox ?? [])
      .filter((message) => message.status === 'pending')
      .map((message) => excerpt(message.text, 240));
    return {
      taskId: task.taskId,
      kind: task.kind,
      prompt: excerpt(task.prompt, 600),
      summary: task.summary,
      mode: task.mode,
      status: task.status,
      phase: lastPhase ? `${lastPhase.phase}:${lastPhase.status}${lastPhase.note ? `:${lastPhase.note}` : ''}` : undefined,
      result: excerpt(task.result, 1200),
      pendingUpdates,
      updatedAt: task.updatedAt,
    };
  }

  private renderTaskContextBundle(taskIds: string[]): string {
    const snapshots = taskIds
      .map((taskId) => this.tasks.get(taskId))
      .filter((task): task is PromptTask => Boolean(task))
      .map((task) => this.buildTaskContextSnapshot(task));
    if (snapshots.length === 0) return '';
    return [
      'Target task context snapshots:',
      JSON.stringify(snapshots, null, 2),
    ].join('\n');
  }

  private routeCandidates(sessionId?: string, excludeTaskIds: string[] = []): TaskContextSnapshot[] {
    const excluded = new Set(excludeTaskIds);
    return [...this.tasks.values()]
      .filter((task) => !excluded.has(task.taskId))
      .filter((task) => sessionId ? task.sessionId === sessionId : this.sessionTaskIds.has(task.taskId))
      .filter((task) => task.kind !== 'clarification')
      .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
      .slice(0, 12)
      .map((task) => this.buildTaskContextSnapshot(task));
  }

  private async routePrompt(
    prompt: string,
    conversationHistory: ConversationEntry[] = [],
    options: PromptDispatchOptions & { excludeTaskIds?: string[] } = {},
  ): Promise<RouteDecision> {
    const candidates = this.routeCandidates(options.sessionId, options.excludeTaskIds ?? []);

    const routePrompt = [
      `Latest user prompt:\n${prompt}`,
      '',
      candidates.length > 0
        ? `Current task snapshots:\n${JSON.stringify(candidates, null, 2)}`
        : 'No existing tasks.',
    ].join('\n');

    try {
      const content = await this.callModelText(routePrompt, MASTER_ROUTER_SYSTEM_PROMPT, conversationHistory, undefined, 'master_router');
      const decision = parseRouteDecision(content, prompt);
      const validIds = new Set(candidates.map((task) => task.taskId));
      decision.targetTaskIds = decision.targetTaskIds.filter((taskId) => validIds.has(taskId));
      if (decision.action !== 'new_task' && decision.action !== 'respond' && decision.targetTaskIds.length === 0) {
        return { action: 'new_task', targetTaskIds: [], reason: 'Router did not select a valid target task.', prompt };
      }
      return decision;
    } catch {
      return { action: 'new_task', targetTaskIds: [], reason: 'Router failed; defaulting to independent task.', prompt };
    }
  }

  private async appendTaskMailboxUpdate(taskId: string, text: string, sourceTaskId?: string): Promise<TaskMailboxMessage | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const message: TaskMailboxMessage = {
      messageId: randomUUID(),
      text,
      sourceTaskId,
      createdAt: now(),
      status: 'pending',
    };
    task.mailbox = [...(task.mailbox ?? []), message];
    await this.persist(task);
    this.emit({ type: 'task_mailbox_updated', taskId, message: { ...message }, ts: now() });
    this.emitTaskUpdate(task);
    return message;
  }

  private async answerTaskQuery(prompt: string, targetTaskIds: string[], conversationHistory: ConversationEntry[] = []): Promise<string> {
    const context = this.renderTaskContextBundle(targetTaskIds);
    const userPrompt = [
      context,
      '',
      `Latest user prompt:\n${prompt}`,
    ].join('\n');
    return this.callModelText(userPrompt, MASTER_QUERY_SYSTEM_PROMPT, conversationHistory, undefined, 'master_query');
  }

  private async absorbMailboxUpdates(task: PromptTask): Promise<string[]> {
    const pending = (task.mailbox ?? []).filter((message) => message.status === 'pending');
    if (pending.length === 0) return [];
    const absorbedAt = now();
    for (const message of pending) {
      message.status = 'absorbed';
      message.absorbedAt = absorbedAt;
    }
    const updates = pending.map((message) => message.text);
    task.prompt = [
      task.prompt,
      '',
      'Additional user requirements absorbed by master:',
      ...updates.map((update) => `- ${update}`),
    ].join('\n');
    task.sharedContext = [
      task.sharedContext ?? '',
      '',
      'Absorbed mailbox updates:',
      ...updates.map((update) => `- ${update}`),
    ].join('\n').trim();
    await this.persist(task);
    this.emitTaskUpdate(task);
    return updates;
  }

  private createTask(
    userId: string,
    prompt: string,
    mode: TaskMode,
    options: {
      kind?: TaskKind;
      sessionId?: string;
      agentRole?: PromptTask['agentRole'];
      relatedTaskIds?: string[];
      sharedContext?: string;
      contextSnapshot?: string;
      readOnly?: boolean;
      artifactDir?: string;
    } = {},
  ): PromptTask {
    const artifactInfo = artifactContext(options.artifactDir);
    const sharedContext = [
      options.sharedContext,
      artifactInfo,
    ].filter(Boolean).join('\n\n') || undefined;
    const task: PromptTask = {
      traceId: telemetry.newTraceId(),
      taskId: randomUUID(),
      sessionId: options.sessionId,
      agentRole: options.agentRole ?? 'worker',
      userId,
      prompt,
      kind: options.kind ?? 'worker',
      mode,
      status: 'queued',
      plan: [],
      phaseEvents: [],
      messages: [],
      pendingClarifications: [],
      relatedTaskIds: options.relatedTaskIds,
      sharedContext,
      contextSnapshot: options.contextSnapshot,
      artifactDir: options.artifactDir,
      readOnly: options.readOnly,
      updatedAt: now(),
    };
    this.tasks.set(task.taskId, task);
    this.sessionTaskIds.add(task.taskId);
    void this.persist(task);
    this.emit({ type: 'task_created', task: this.cloneTask(task), ts: now() });
    this.emitTaskUpdate(task);
    // Asynchronously generate a short human-readable name for the task.
    void this.generateTaskName(task);
    return task;
  }

  private async generateTaskName(task: PromptTask): Promise<void> {
    try {
      const name = await this.callModelText(
        task.prompt,
        'You are a task naming assistant. Given a user task description, respond with ONLY a short 3-6 word action phrase (e.g. "Fix auth error handling", "Refactor payment service"). No punctuation at the end, no quotes, no explanation.',
        [],
        undefined,
        'task_name',
      );
      const cleaned = name.replace(/^["']|["']$/g, '').trim();
      if (cleaned && cleaned.length < 80) {
        task.summary = cleaned;
        this.emitTaskUpdate(task);
      }
    } catch {
      // Non-critical: fall back to truncated prompt as title
    }
  }

  private kindForRouteAction(action: RouteAction): TaskKind {
    if (action === 'derived_task') return 'derived_worker';
    if (action === 'sync_task') return 'sync_worker';
    if (action === 'clarify_target') return 'clarification';
    if (action === 'query_task' || action === 'update_task') return 'inquiry';
    return 'worker';
  }

  private async emitUserVisibleMessage(task: PromptTask | undefined, sourceText: string, label = 'presentation'): Promise<string> {
    if (!sourceText?.trim()) return '';
    let text = '';
    if (task) {
      try {
        const prompt = [
          `Original user request:\n${task.prompt}`,
          task.relatedTaskIds?.length ? `Related tasks: ${task.relatedTaskIds.join(', ')}` : '',
          `Worker/writer result:\n${sourceText}`,
        ].filter(Boolean).join('\n\n');
        const presented = await this.callModelText(prompt, PRESENTATION_SYSTEM_PROMPT, [], task, label);
        if (presented.trim()) text = presented.trim();
      } catch {
        // presentation failed — don't show raw instructions
      }
      if (text) {
        const message = { messageId: randomUUID(), text, ts: now() };
        task.visibleMessages = [...(task.visibleMessages ?? []), message].slice(-20);
        await this.persist(task);
        this.emitTaskUpdate(task);
      }
    }
    if (text) {
      this.emit({
        type: 'user_visible_message',
        taskId: task?.taskId,
        sessionId: task?.sessionId,
        role: 'assistant',
        text,
        ts: now(),
      });
    }
    return text;
  }

  private async completeInquiryTask(task: PromptTask, result: string, relatedTaskIds: string[] = []): Promise<void> {
    task.kind = 'inquiry';
    task.agentRole = 'presentation';
    task.relatedTaskIds = relatedTaskIds.length ? relatedTaskIds : task.relatedTaskIds;
    task.status = 'completed';
    task.result = result;
    task.completedAt = now();
    await this.persist(task);
    this.emitTaskUpdate(task);
    this.emit({ type: 'task_done', taskId: task.taskId, result, status: 'completed', ts: now() });
    await this.emitUserVisibleMessage(task, result);
  }

  private async routeAndRunAcceptedTask(
    taskId: string,
    originalPrompt: string,
    conversationHistory: ConversationEntry[],
    precomputedDecision?: RouteDecision,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    this.pendingRouteTasks.delete(taskId);
    if (this.routingTasks.has(taskId)) return;
    this.routingTasks.add(taskId);

    try {
      const decision = precomputedDecision ?? await this.routePrompt(originalPrompt, conversationHistory, {
        sessionId: task.sessionId,
        excludeTaskIds: [task.taskId],
      });

      if (decision.action === 'respond') {
        // Should not normally reach here (handled in acceptPrompt), but handle gracefully
        task.status = 'completed';
        task.completedAt = now();
        await this.persist(task);
        this.emitTaskUpdate(task);
        this.emit({ type: 'task_done', taskId: task.taskId, result: '', status: 'completed', ts: now() });
        return;
      }

      if (decision.action === 'query_task') {
        task.status = 'running';
        task.kind = 'inquiry';
        task.agentRole = 'master';
        task.relatedTaskIds = decision.targetTaskIds;
        await this.persist(task);
        this.emitTaskUpdate(task);
        const answer = await this.answerTaskQuery(decision.prompt || originalPrompt, decision.targetTaskIds, conversationHistory);
        this.emit({ type: 'master_response', text: answer, relatedTaskIds: decision.targetTaskIds, ts: now() });
        await this.completeInquiryTask(task, answer, decision.targetTaskIds);
        return;
      }

      if (decision.action === 'update_task') {
        const targetId = decision.targetTaskIds[0]!;
        task.status = 'running';
        task.kind = 'inquiry';
        task.agentRole = 'master';
        task.relatedTaskIds = [targetId];
        await this.persist(task);
        this.emitTaskUpdate(task);

        await this.appendTaskMailboxUpdate(targetId, decision.prompt || originalPrompt);
        const target = this.tasks.get(targetId);
        if (target && (target.status === 'completed' || target.status === 'failed' || target.status === 'blocked')) {
          target.status = 'queued';
          await this.persist(target);
          this.emitTaskUpdate(target);
          this.enqueueTaskRun(targetId);
        }
        await this.completeInquiryTask(task, `Queued update for task ${targetId.slice(0, 8)}.`, [targetId]);
        return;
      }

      if (decision.action === 'clarify_target') {
        task.status = 'running';
        task.kind = 'inquiry';
        task.agentRole = 'master';
        task.relatedTaskIds = decision.targetTaskIds;
        await this.persist(task);
        this.emitTaskUpdate(task);

        const choices = decision.targetTaskIds
          .map((targetId) => this.tasks.get(targetId))
          .filter((target): target is PromptTask => Boolean(target))
          .map((target) => `${target.taskId.slice(0, 8)} - ${target.summary ?? excerpt(target.prompt, 56)}`);
        const selected = await this.requestClarification(
          task.taskId,
          decision.reason || 'Which existing task should this prompt apply to?',
          choices,
        );
        const targetId = decision.targetTaskIds[choices.indexOf(selected)];
        if (!targetId) {
          await this.completeInquiryTask(task, 'No matching task was selected.', decision.targetTaskIds);
          return;
        }

        if (/\?|^(how|what|where|when|why|which|status|progress)\b/i.test(originalPrompt.trim())) {
          const answer = await this.answerTaskQuery(decision.prompt || originalPrompt, [targetId], conversationHistory);
          this.emit({ type: 'master_response', text: answer, relatedTaskIds: [targetId], ts: now() });
          await this.completeInquiryTask(task, answer, [targetId]);
          return;
        }

        await this.appendTaskMailboxUpdate(targetId, decision.prompt || originalPrompt, task.taskId);
        const target = this.tasks.get(targetId);
        if (target && (target.status === 'completed' || target.status === 'failed' || target.status === 'blocked')) {
          target.status = 'queued';
          await this.persist(target);
          this.emitTaskUpdate(target);
          this.enqueueTaskRun(targetId);
        }
        await this.completeInquiryTask(task, `Queued update for task ${targetId.slice(0, 8)}.`, [targetId]);
        return;
      }

      const targetContext = this.renderTaskContextBundle(decision.targetTaskIds);
      task.kind = this.kindForRouteAction(decision.action);
      task.agentRole = 'worker';
      task.prompt = decision.prompt || originalPrompt;
      task.relatedTaskIds = decision.targetTaskIds.length > 0 ? decision.targetTaskIds : undefined;
      task.sharedContext = [targetContext, artifactContext(task.artifactDir)].filter(Boolean).join('\n\n') || undefined;
      task.contextSnapshot = targetContext || undefined;
      await this.persist(task);
      this.emitTaskUpdate(task);
      void this.runTask(task.taskId);
    } catch (error) {
      task.status = 'failed';
      task.result = `Error: ${String(error)}`;
      task.completedAt = now();
      await this.persist(task);
      this.emitTaskUpdate(task);
      this.emit({ type: 'task_done', taskId: task.taskId, result: task.result, status: 'failed', ts: now() });
      await this.emitUserVisibleMessage(task, task.result);
    } finally {
      this.routingTasks.delete(taskId);
    }
  }

  async acceptPrompt(
    userId: string,
    prompt: string,
    mode: TaskMode = 'build',
    conversationHistory: ConversationEntry[] = [],
    options: PromptDispatchOptions = {},
  ): Promise<string> {
    const sessionId = options.sessionId;
    const activeTask = this.findActiveTask(sessionId);

    if (activeTask) {
      await this.appendTaskMailboxUpdate(activeTask.taskId, prompt);
      await this.emitUserVisibleMessage(activeTask, prompt);
      return activeTask.taskId;
    }

    // Route first — decide if this needs a task or just a direct response
    const decision = await this.routePrompt(prompt, conversationHistory, {
      sessionId,
      excludeTaskIds: [],
    });

    if (decision.action === 'respond') {
      // Master responds directly — no task capsule
      const answer = await this.callModelText(prompt, MASTER_SYSTEM_PROMPT, conversationHistory, undefined, 'master_direct');
      this.emit({
        type: 'user_visible_message',
        taskId: undefined,
        sessionId,
        role: 'assistant',
        text: answer,
        ts: now(),
      });
      return 'respond';
    }

    // Needs a real task — create it now
    const task = this.createTask(userId, prompt, mode, {
      kind: 'worker',
      sessionId,
      agentRole: 'master',
      artifactDir: options.artifactDir,
    });
    this.taskHistory.set(task.taskId, [...conversationHistory]);
    this.pendingRouteTasks.add(task.taskId);
    setTimeout(() => {
      void this.routeAndRunAcceptedTask(task.taskId, prompt, conversationHistory, decision);
    }, 0);
    return task.taskId;
  }
  private findActiveTask(sessionId?: string): PromptTask | undefined {
    const tasks = this.listTasks({ sessionId });
    return tasks.find(t => ['running', 'waiting_user', 'blocked'].includes(t.status));
  }

  getTask(taskId: string): PromptTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(options: ListTaskOptions = {}): PromptTask[] {
    const tasks = [...this.tasks.values()];
    if (!options.sessionId) return tasks;
    return tasks.filter((task) => task.sessionId === options.sessionId);
  }

/** Stop a task at the next safe execution boundary. */
  async cancelTask(taskId: string, reason = 'Cancelled by user'): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || ['completed', 'failed'].includes(task.status)) return false;
    this.taskControllers.get(taskId)?.abort(reason);
    task.status = 'failed';
    task.result = reason;
    task.completedAt = now();
    await this.persist(task);
    this.emitTaskUpdate(task);
    this.emit({ type: 'task_done', taskId, result: reason, status: 'failed', ts: now() });
    return true;
  }

  /** Classify and apply a user steering message without blocking reception. */
  async steerTask(taskId: string, update: string): Promise<'correct_now' | 'augment' | 'new_task' | 'query' | 'not_found'> {
    const task = this.tasks.get(taskId);
    if (!task) return 'not_found';
    const text = update.trim();
    const lower = text.toLowerCase();
    const query = /^(what|why|status|progress|where|how far|现在|进度|做到|为什么)/i.test(text);
    const correction = /(stop|cancel|abort|wrong|mistake|instead|不要|停下|取消|错了|不对|改成|换成|别这样)/i.test(lower);
    if (query) return 'query';
    if (correction && this.runningTasks.has(taskId)) {
      this.taskControllers.get(taskId)?.abort(`Steering correction: ${text}`);
      await this.appendTaskMailboxUpdate(taskId, text);
      task.status = 'queued';
      task.result = undefined;
      await this.persist(task);
      this.emitTaskUpdate(task);
      return 'correct_now';
    }
    await this.appendTaskMailboxUpdate(taskId, text);
    return 'augment';
  }

  async saveTask(task: PromptTask): Promise<void> {
    await this.persist(task);
  }

  async updateGoal(taskId: string, goal: Goal): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.goal = goal;
    await this.persist(task);
    this.emit({ type: 'goal_status_changed', taskId, goal: { ...goal }, ts: now() });
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
    const trimmedAnswer = answer.trim();
    if (!trimmedAnswer) return false;
    const selectedAnswer = request.choices.find((choice) => choice === trimmedAnswer) ?? trimmedAnswer;

    request.status = 'answered';
    request.answer = selectedAnswer;
    task.status = 'running';
    void this.persist(task);
    this.emit({
      type: 'clarification_answered',
      taskId,
      clarificationId,
      answer: selectedAnswer,
      ts: now(),
    });
    this.emitTaskUpdate(task);

    pending.resolve(selectedAnswer);
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
    if (this.pendingRouteTasks.has(taskId) || this.routingTasks.has(taskId) || this.runningTasks.has(taskId) || this.scheduledTaskRuns.has(taskId)) return true;
    task.mode = 'build';
    task.prompt = `Execute this approved plan:\n${task.plan.map((step) => `- ${step.title}: ${step.detail}`).join('\n')}`;
    task.status = 'queued';
    await this.persist(task);
    this.emitTaskUpdate(task);
    this.enqueueTaskRun(taskId);
    return true;
  }

  async resolveTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'completed' || task.status === 'failed') return false;
    if (this.pendingRouteTasks.has(taskId) || this.routingTasks.has(taskId) || this.runningTasks.has(taskId) || this.scheduledTaskRuns.has(taskId)) return true;
    task.status = 'queued';
    await this.persist(task);
    this.emitTaskUpdate(task);
    this.enqueueTaskRun(taskId);
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

  private clonePatch(patch: PatchSet): PatchSet {
    return {
      ...patch,
      files: patch.files.map((file) => ({ ...file })),
      verificationCommands: [...patch.verificationCommands],
      conflicts: patch.conflicts ? patch.conflicts.map((conflict) => ({ ...conflict })) : undefined,
    };
  }

  private async fillPatchDiffs(patch: PatchSet): Promise<void> {
    await Promise.all(patch.files.map(async (file) => {
      if (file.diff) return;
      let before = file.before;
      if (before === undefined) {
        const absolutePath = isAbsolute(file.path) ? file.path : resolve(process.cwd(), file.path);
        try {
          before = await readFile(absolutePath, 'utf8');
        } catch {
          before = '';
        }
      }
      file.diff = unifiedDiff(file.path, before, file.after);
    }));
  }

  private async persistPatch(task: PromptTask, patch: PatchSet): Promise<void> {
    patch.updatedAt = now();
    const existing = task.patchSets ?? [];
    const index = existing.findIndex((item) => item.patchId === patch.patchId);
    if (index >= 0) {
      existing[index] = patch;
      task.patchSets = existing;
    } else {
      task.patchSets = [...existing, patch];
    }
    await this.persist(task);
    this.emitTaskUpdate(task);
  }

  private async submitPatch(
    taskId: string,
    input: Omit<PatchSet, 'patchId' | 'taskId' | 'status' | 'createdAt' | 'updatedAt'>,
  ): Promise<string> {
    const task = this.tasks.get(taskId);
    if (!task) return `WriterError: task ${taskId} not found`;

    const patch: PatchSet = {
      patchId: randomUUID(),
      taskId,
      summary: input.summary || 'Patch submitted by worker',
      files: input.files.map((file) => ({ ...file })),
      verificationCommands: input.verificationCommands.filter(Boolean),
      status: 'submitted',
      createdAt: now(),
      updatedAt: now(),
    };

    await this.fillPatchDiffs(patch);

    await this.persistPatch(task, patch);
    this.emit({ type: 'writer_patch_submitted', taskId, patch: this.clonePatch(patch), ts: now() });

    const paths = [...new Set(patch.files.map((file) => file.path))].sort();
    const releases = [];
    for (const path of paths) {
      releases.push(await this.fileLocks.acquire(path));
    }

    try {
      const conflicts: NonNullable<PatchSet['conflicts']> = [];
      for (const file of patch.files) {
        const absolutePath = isAbsolute(file.path) ? file.path : resolve(process.cwd(), file.path);
        let current = '';
        let exists = true;
        try {
          current = await readFile(absolutePath, 'utf8');
        } catch {
          exists = false;
          current = '';
        }

        const actualHash = contentHash(current);
        const expectedHash = file.baseHash || (file.before !== undefined ? contentHash(file.before) : undefined);
        const expectedMissing = expectedHash === 'missing' && !exists;
        if (expectedHash && expectedHash !== actualHash && !expectedMissing) {
          conflicts.push({
            path: file.path,
            expectedHash,
            actualHash: exists ? actualHash : 'missing',
          });
        }
      }

      if (conflicts.length > 0) {
        patch.status = 'conflict';
        patch.conflicts = conflicts;
        patch.result = `Patch has ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}.`;
        await this.persistPatch(task, patch);
        this.emit({ type: 'writer_conflict', taskId, patch: this.clonePatch(patch), conflicts, ts: now() });
        await this.emitUserVisibleMessage(task, patch.result, 'writer_conflict_presentation');
        return `WriterConflict: ${patch.result}`;
      }

      for (const file of patch.files) {
        const absolutePath = isAbsolute(file.path) ? file.path : resolve(process.cwd(), file.path);
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, file.after, 'utf8');
      }

      patch.status = 'applied';
      patch.result = `Applied patch ${patch.patchId.slice(0, 8)} to ${patch.files.length} file${patch.files.length === 1 ? '' : 's'}.`;
      await this.persistPatch(task, patch);
      this.emit({ type: 'writer_patch_applied', taskId, patch: this.clonePatch(patch), ts: now() });

      const verificationOutput: string[] = [];
      for (const command of patch.verificationCommands) {
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: process.cwd(),
            timeout: 120_000,
            maxBuffer: 1024 * 1024 * 4,
          });
          verificationOutput.push([`$ ${command}`, stdout, stderr].filter(Boolean).join('\n'));
        } catch (error) {
          const err = error as { stdout?: string; stderr?: string; message?: string };
          const output = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
          patch.status = 'failed';
          patch.result = `Verification failed for "${command}".\n${output}`;
          await this.persistPatch(task, patch);
          this.emit({ type: 'writer_failed', taskId, patch: this.clonePatch(patch), error: patch.result, ts: now() });
          await this.emitUserVisibleMessage(task, patch.result, 'writer_failed_presentation');
          return `WriterFailed: ${patch.result}`;
        }
      }

      patch.status = 'verified';
      patch.result = verificationOutput.length > 0
        ? `Patch applied and verified.\n${verificationOutput.join('\n\n')}`
        : 'Patch applied. No verification commands were provided.';
      await this.persistPatch(task, patch);
      this.emit({ type: 'writer_patch_verified', taskId, patch: this.clonePatch(patch), ts: now() });
      return `WriterApplied: ${patch.result}`;
    } catch (error) {
      patch.status = 'failed';
      patch.result = `Writer failed: ${String(error)}`;
      await this.persistPatch(task, patch);
      this.emit({ type: 'writer_failed', taskId, patch: this.clonePatch(patch), error: patch.result, ts: now() });
      await this.emitUserVisibleMessage(task, patch.result, 'writer_failed_presentation');
      return `WriterFailed: ${patch.result}`;
    } finally {
      for (const release of releases.reverse()) {
        await release();
      }
    }
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
    const taskPolicy = sub.readOnly ? readOnlyPolicy(this.basePolicy) : clonePolicy(this.basePolicy);
    const artifactDir = this.tasks.get(sub.parentTaskId)?.artifactDir;
    if (!sub.readOnly && artifactDir && !taskPolicy.allowedWriteRoots.includes(artifactDir)) {
      taskPolicy.allowedWriteRoots.push(artifactDir);
    }
    const toolCtx: ToolContext = {
      spawnSubagent: async () => 'Error: subagents cannot spawn other subagents',
      collectSubagent: async () => 'Error: subagents cannot collect siblings directly',
      requestClarification: (question, choices) => this.requestClarification(sub.parentTaskId || sub.taskId, question, choices),
      submitPatch: (patch) => this.submitPatch(sub.parentTaskId || sub.taskId, patch),
      acquireWriteLock: (path) => this.fileLocks.acquire(path),
      policy: taskPolicy,
      artifactDir,
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
    mode: TaskMode = 'build',
    conversationHistory: ConversationEntry[] = [],
    options: PromptDispatchOptions = {},
  ): AsyncGenerator<StreamChunk> {
    // Route first — decide if this needs a task or just a direct response
    const decision = await this.routePrompt(prompt, conversationHistory, {
      sessionId: options.sessionId,
      excludeTaskIds: [],
    });

    if (decision.action === 'respond') {
      // Master responds directly — no task capsule
      const answer = await this.callModelText(prompt, MASTER_SYSTEM_PROMPT, conversationHistory, undefined, 'master_direct');
      this.emit({
        type: 'user_visible_message',
        taskId: undefined,
        sessionId: options.sessionId,
        role: 'assistant',
        text: answer,
        ts: now(),
      });
      yield { type: 'token', text: answer };
      yield { type: 'done', result: answer };
      return;
    }

    // Needs a real task — create it now
    const task = this.createTask(userId, prompt, mode, {
      kind: 'worker',
      sessionId: options.sessionId,
      agentRole: 'master',
      artifactDir: options.artifactDir,
    });
    this.taskHistory.set(task.taskId, [...conversationHistory]);
    yield { type: 'task_id', taskId: task.taskId };

    if (decision.action === 'query_task') {
      task.status = 'running';
      task.kind = 'inquiry';
      task.agentRole = 'master';
      task.relatedTaskIds = decision.targetTaskIds;
      await this.persist(task);
      this.emitTaskUpdate(task);
      const answer = await this.answerTaskQuery(decision.prompt || prompt, decision.targetTaskIds, conversationHistory);
      this.emit({ type: 'master_response', text: answer, relatedTaskIds: decision.targetTaskIds, ts: now() });
      await this.completeInquiryTask(task, answer, decision.targetTaskIds);
      yield { type: 'token', text: answer };
      yield { type: 'done', result: answer };
      return;
    }
    if (decision.action === 'update_task') {
      const targetId = decision.targetTaskIds[0]!;
      task.status = 'running';
      task.kind = 'inquiry';
      task.agentRole = 'master';
      task.relatedTaskIds = [targetId];
      await this.persist(task);
      this.emitTaskUpdate(task);
      await this.appendTaskMailboxUpdate(targetId, decision.prompt || prompt);
      const target = this.tasks.get(targetId);
      if (target && (target.status === 'completed' || target.status === 'failed' || target.status === 'blocked')) {
        target.status = 'queued';
        await this.persist(target);
        this.emitTaskUpdate(target);
        this.enqueueTaskRun(targetId);
      }
      const result = `Queued update for task ${targetId.slice(0, 8)}.`;
      await this.completeInquiryTask(task, result, [targetId]);
      yield { type: 'token', text: result };
      yield { type: 'done', result };
      return;
    }

    if (decision.action === 'clarify_target') {
      task.status = 'running';
      task.kind = 'inquiry';
      task.agentRole = 'master';
      task.relatedTaskIds = decision.targetTaskIds;
      await this.persist(task);
      this.emitTaskUpdate(task);

      const choices = decision.targetTaskIds
        .map((targetId) => this.tasks.get(targetId))
        .filter((target): target is PromptTask => Boolean(target))
        .map((target) => `${target.taskId.slice(0, 8)} - ${target.summary ?? excerpt(target.prompt, 56)}`);
      const selected = await this.requestClarification(
        task.taskId,
        decision.reason || 'Which existing task should this prompt apply to?',
        choices,
      );
      const targetId = decision.targetTaskIds[choices.indexOf(selected)];
      if (!targetId) {
        const result = 'No matching task was selected.';
        await this.completeInquiryTask(task, result, decision.targetTaskIds);
        yield { type: 'token', text: result };
        yield { type: 'done', result };
        return;
      }

      if (/\?|^(how|what|where|when|why|which|status|progress)\b/i.test(prompt.trim())) {
        const answer = await this.answerTaskQuery(decision.prompt || prompt, [targetId], conversationHistory);
        this.emit({ type: 'master_response', text: answer, relatedTaskIds: [targetId], ts: now() });
        await this.completeInquiryTask(task, answer, [targetId]);
        yield { type: 'token', text: answer };
        yield { type: 'done', result: answer };
        return;
      }

      await this.appendTaskMailboxUpdate(targetId, decision.prompt || prompt, task.taskId);
      const target = this.tasks.get(targetId);
      if (target && (target.status === 'completed' || target.status === 'failed' || target.status === 'blocked')) {
        target.status = 'queued';
        await this.persist(target);
        this.emitTaskUpdate(target);
        this.enqueueTaskRun(targetId);
      }
      const result = `Queued update for task ${targetId.slice(0, 8)}.`;
      await this.completeInquiryTask(task, result, [targetId]);
      yield { type: 'token', text: result };
      yield { type: 'done', result };
      return;
    }

    const targetContext = this.renderTaskContextBundle(decision.targetTaskIds);
    task.kind = this.kindForRouteAction(decision.action);
    task.agentRole = 'worker';
    task.prompt = decision.prompt || prompt;
    task.relatedTaskIds = decision.targetTaskIds.length > 0 ? decision.targetTaskIds : undefined;
    task.sharedContext = [targetContext, artifactContext(task.artifactDir)].filter(Boolean).join('\n\n') || undefined;
    task.contextSnapshot = targetContext || undefined;
    task.status = 'running';
    task.startedAt ??= now();
    await this.persist(task);
    this.emitTaskUpdate(task);
    yield* this.runTaskStream(task, conversationHistory);
  }

  private async runTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (this.runningTasks.has(taskId)) return;
    this.runningTasks.add(taskId);
    const controller = new AbortController();
    this.taskControllers.set(taskId, controller);

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
            await this.emitUserVisibleMessage(task, chunk.result);
            break;
          case 'error':
            this.emit({ type: 'task_done', taskId: task.taskId, result: chunk.message, status: 'failed', ts: now() });
            await this.emitUserVisibleMessage(task, chunk.message);
            break;
          default:
            break;
        }
      }
    } finally {
      this.runningTasks.delete(taskId);
      this.taskControllers.delete(taskId);
      if (['completed', 'failed'].includes(task.status)) {
        this.rememberTask(task);
      }
      this.emitTaskUpdate(task);
      if ((task.status as string) === 'queued') this.enqueueTaskRun(taskId);
    }
  }

  private async requestClarification(taskId: string, question: string, choices: string[] = []): Promise<string> {
    const task = this.tasks.get(taskId);
    if (!task) return '';

    const clarificationId = randomUUID();
    const normalizedQuestion = question.trim() || 'Choose how this task should continue.';
    let finalChoices = choices.length > 0 ? normalizeClarificationChoices(normalizedQuestion, choices) : [];
    if (finalChoices.length < 2) {
      const prompt = [
        `Task: ${task.prompt}`,
        `Question: ${normalizedQuestion}`,
        task.sharedContext ? `Shared context:\n${task.sharedContext}` : '',
        '',
        'Generate 2 to 4 concrete answer choices for the user.',
        'Rules:',
        '- Return ONLY valid JSON array.',
        '- Each item must have "label" and "value" strings.',
        '- Choices must be specific and useful, not yes/no or generic.',
        '- Keep labels short and distinct.',
      ].filter(Boolean).join('\n');
      try {
        const content = await this.callModelText(prompt, MASTER_SYSTEM_PROMPT, [], task, 'clarification_choices');
        finalChoices = normalizeClarificationChoices(normalizedQuestion, parseClarificationChoices(content));
      } catch {
        finalChoices = normalizeClarificationChoices(normalizedQuestion);
      }
    }
    const request: ClarificationRequest = {
      clarificationId,
      taskId,
      question: normalizedQuestion,
      choices: finalChoices,
      createdAt: now(),
      status: 'pending',
    };
    const response = new Promise<string>((resolve) => {
      this.clarifications.set(clarificationId, {
        taskId,
        resolve: (answer) => {
          resolve(answer);
        },
      });
    });
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

    return response;
  }

  private async *runTaskStream(
    task: PromptTask,
    conversationHistory: ConversationEntry[],
  ): AsyncGenerator<StreamChunk> {
    try {
      const signal = this.taskControllers.get(task.taskId)?.signal;
      if (signal?.aborted) return;
      if (!task.sharedContext && task.relatedTaskIds?.length) {
        task.sharedContext = this.renderTaskContextBundle(task.relatedTaskIds);
      }
      await this.absorbMailboxUpdates(task);
      if (this.taskControllers.get(task.taskId)?.signal.aborted) return;

      // Extract goal from prompt if present
      if (!task.goal) {
        const goalMatch = task.prompt.match(/\[GOAL\]\s*([\s\S]*?)\s*\[\/GOAL\]/i);
        const criteriaMatch = task.prompt.match(/\[CRITERIA\]\s*([\s\S]*?)\s*\[\/CRITERIA\]/i);
        if (goalMatch) {
          task.goal = {
            description: goalMatch[1].trim(),
            completionCriteria: criteriaMatch?.[1]?.trim() ?? 'All planned steps are completed and verified.',
            status: 'in_progress',
          };
          task.todos = [];
          task.goalIteration = 0;
          this.emit({ type: 'goal_status_changed', taskId: task.taskId, goal: { ...task.goal }, ts: now() });
          await this.persist(task);
        }
      }

      const toolCtx = this.createToolContext(task);
      const maxGoalIterations = 5;

      if (task.goal) {
        // Goal-driven loop
        let history = [...conversationHistory];
        for (let iter = 0; iter < maxGoalIterations; iter++) {
          task.goalIteration = iter + 1;
          const iterLabel = `Goal iteration ${iter + 1}/${maxGoalIterations}`;

          // Compress history if needed
          history = await this.compressHistory(task, history);

          // Plan
          this.markPhase(task, 'plan', 'in_progress', iterLabel);
          yield { type: 'phase', phase: 'plan', status: 'in_progress', note: iterLabel };
          const planner = await this.planTask(task, history);
          task.planner = planner;
          task.summary = planner.summary;
          task.readOnly = planner.readOnly;
          task.plan = planner.steps;
          task.todos = this.todosFromPlanner(planner);
          this.emit({ type: 'todo_updated', taskId: task.taskId, todos: task.todos.map(t => ({ ...t })), ts: now() });
          await this.persist(task);
          this.markPhase(task, 'plan', 'done', `${planner.steps.length} step${planner.steps.length === 1 ? '' : 's'}`);
          yield { type: 'phase', phase: 'plan', status: 'done', note: `${planner.steps.length} step${planner.steps.length === 1 ? '' : 's'}` };

          if (planner.questions[0]) {
            const answer = await this.requestClarification(task.taskId, planner.questions[0]);
            task.prompt = `${task.prompt}\n\nClarification from user:\n${answer}`;
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

          // Execute steps
          const iterResult = yield* this.streamPlannerDrivenFlow(task, history, toolCtx, planner.steps);

          // Append to conversation history
          history.push({ role: 'user', content: task.prompt });
          history.push({ role: 'assistant', content: iterResult });

          // Verify goal
          const verification = await this.verifyGoal(task, iterResult);
          task.todos = verification.todos;
          this.emit({ type: 'todo_updated', taskId: task.taskId, todos: task.todos.map(t => ({ ...t })), ts: now() });

          if (verification.achieved) {
            task.goal.status = 'achieved';
            this.emit({ type: 'goal_status_changed', taskId: task.taskId, goal: { ...task.goal }, ts: now() });
            task.result = iterResult;
            task.status = 'completed';
            task.completedAt = now();
            await this.persist(task);
            yield { type: 'token', text: `\n\nGoal achieved: ${verification.reason}\n` };
            yield { type: 'done', result: iterResult };
            return;
          }

          // Not achieved — inject feedback and continue
          const feedbackNote = `\n\n[Goal iteration ${iter + 1} incomplete: ${verification.reason}. Continuing...]\n`;
          yield { type: 'token', text: feedbackNote };
          task.prompt = `${task.prompt}\n\nPrevious iteration feedback:\n${verification.reason}`;
          await this.persist(task);
        }

        // Exhausted iterations
        task.goal.status = 'failed';
        this.emit({ type: 'goal_status_changed', taskId: task.taskId, goal: { ...task.goal }, ts: now() });
        task.result = `Goal not achieved after ${maxGoalIterations} iterations.`;
        task.status = 'completed';
        task.completedAt = now();
        await this.persist(task);
        yield { type: 'token', text: `\n\nGoal not achieved after ${maxGoalIterations} iterations.\n` };
        yield { type: 'done', result: task.result };
      } else {
        // Non-goal flow (existing behavior)
        this.markPhase(task, 'plan', 'in_progress', 'Planning next steps…');
        yield { type: 'phase', phase: 'plan', status: 'in_progress', note: 'Planning next steps…' };
        const planner = await this.planTask(task, conversationHistory);
        task.planner = planner;
        task.summary = planner.summary;
        task.readOnly = planner.readOnly;
        task.plan = planner.steps;
        task.todos = this.todosFromPlanner(planner);
        this.emit({ type: 'todo_updated', taskId: task.taskId, todos: task.todos.map(t => ({ ...t })), ts: now() });
        await this.persist(task);
        this.markPhase(task, 'plan', 'done', `${planner.steps.length} step${planner.steps.length === 1 ? '' : 's'}`);
        yield { type: 'phase', phase: 'plan', status: 'done', note: `${planner.steps.length} step${planner.steps.length === 1 ? '' : 's'}` };

        if (planner.questions[0]) {
          const answer = await this.requestClarification(task.taskId, planner.questions[0]);
          task.prompt = `${task.prompt}\n\nClarification from user:\n${answer}`;
          if (task.relatedTaskIds?.length) {
            task.sharedContext = this.renderTaskContextBundle(task.relatedTaskIds);
          }
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

        const fullResult = yield* this.streamPlannerDrivenFlow(task, conversationHistory, toolCtx, planner.steps);
        task.result = fullResult;
        if (task.todos?.length) {
          task.todos = task.todos.map((todo) => ({ ...todo, status: 'done' as const }));
          this.emit({ type: 'todo_updated', taskId: task.taskId, todos: task.todos.map(t => ({ ...t })), ts: now() });
        }
        task.status = 'completed';
        task.completedAt = now();
        await this.persist(task);
        yield { type: 'done', result: fullResult };
      }
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

  // ── Context compression ────────────────────────────────────────────────
  private async compressHistory(task: PromptTask, history: ConversationEntry[]): Promise<ConversationEntry[]> {
    const contextWindow = this.backend.contextWindow ?? 131072;
    const maxInputTokens = Math.floor(contextWindow * 0.6);
    const estimated = history.reduce((sum, e) => sum + Math.ceil(e.content.length / 4), 0);
    if (estimated < maxInputTokens) return history;

    const userMsg = history.length > 0 ? history[history.length - 1].content : '';
    const summary = await this.callModelText(
      history.map(e => `${e.role}: ${e.content}`).join('\n\n'),
      CONTEXT_SUMMARIZER_PROMPT,
      [],
      task,
      'context_compression',
    );
    return [
      { role: 'user', content: `[Context summary from previous iterations]\n${summary}` },
      ...(userMsg ? [{ role: 'user' as const, content: userMsg }] : []),
    ];
  }

  private todosFromPlanner(planner: ParsedPlannerDecision): TodoItem[] {
    const source = planner.todos?.length
      ? planner.todos
      : planner.steps.map((step, index) => ({
          id: `step-${index + 1}`,
          text: step.title || step.detail || `Step ${index + 1}`,
          status: 'pending' as const,
        }));
    return source
      .filter((todo) => todo.text.trim())
      .map((todo, index) => ({
        id: todo.id || `step-${index + 1}`,
        text: todo.text,
        status: index === 0 && todo.status === 'pending' ? 'in_progress' : todo.status,
      }));
  }

  // ── Goal verification ─────────────────────────────────────────────────
  private async verifyGoal(
    task: PromptTask,
    result: string,
  ): Promise<{ achieved: boolean; reason: string; todos: TodoItem[] }> {
    const goal = task.goal!;
    const prompt = [
      `Goal: ${goal.description}`,
      `Completion criteria: ${goal.completionCriteria}`,
      `Current todos:\n${(task.todos ?? []).map(t => `- [${t.status}] ${t.text}`).join('\n') || '(none)'}`,
      '',
      'Work done so far:',
      result.slice(-3000),
    ].join('\n');
    try {
      const content = await this.callModelText(prompt, GOAL_VERIFIER_PROMPT, [], task, 'goal_verifier');
      const trimmed = content.trim();
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const parsed = JSON.parse((fenced?.[1] ?? trimmed).trim());
      const todos: TodoItem[] = Array.isArray(parsed.todos)
        ? parsed.todos.map((t: Record<string, unknown>) => ({
            id: String(t.id ?? randomUUID().slice(0, 8)),
            text: String(t.text ?? ''),
            status: (['done', 'in_progress', 'pending'].includes(String(t.status)) ? t.status : 'pending') as TodoItem['status'],
          }))
        : task.todos ?? [];
      return { achieved: Boolean(parsed.achieved), reason: String(parsed.reason ?? ''), todos };
    } catch {
      return { achieved: false, reason: 'Verification failed; could not parse result.', todos: task.todos ?? [] };
    }
  }

  private async *streamPlannerDrivenFlow(
    task: PromptTask,
    conversationHistory: ConversationEntry[],
    toolCtx: ToolContext,
    steps: PlanStep[],
  ): AsyncGenerator<StreamChunk, string> {
    // Autonomous loop: the model chooses the next action from tool results and
    // current context. Planner output is retained as a hint/summary only; it
    // never dictates a fixed workflow or tool sequence.
    this.markPhase(task, 'execute', 'in_progress', 'Autonomous loop');
    yield { type: 'phase', phase: 'execute', status: 'in_progress', note: 'Autonomous loop' };
    const messages: OllamaMsg[] = [
      ...conversationHistory.map((entry) => ({ role: entry.role, content: entry.content })),
      {
        role: 'user',
        content: [
          task.sharedContext ? `Context:\n${task.sharedContext}` : '',
          `Goal:\n${task.prompt}`,
          '自主解决问题：自行决定下一步，按需读取、修改、测试、诊断并迭代；不要遵循预先枚举的流程，只有在目标已验证或明确受阻时才停止。',
        ].filter(Boolean).join('\n\n'),
      },
    ];
    let result = '';
    for await (const chunk of this.runToolLoopStream(messages, 40, toolCtx, Boolean(task.readOnly), 'autonomous_loop', (text) => {
      result += text;
    }, undefined, undefined, AUTONOMOUS_SYSTEM_PROMPT)) {
      yield chunk;
    }
    this.markPhase(task, 'execute', 'done', 'Autonomous loop finished');
    yield { type: 'phase', phase: 'execute', status: 'done', note: 'Autonomous loop finished' };
    return result.trim();
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
          return new Set(['repo_map', 'read_file', 'read_files', 'file_info', 'list_dir', 'search_text', 'search_files', 'git_status', 'git_diff', 'git_log', 'bash', 'load_skill', 'request_clarification']);
        case 'code_write':
          return new Set(['repo_map', 'read_file', 'read_files', 'file_info', 'list_dir', 'search_text', 'search_files', 'git_status', 'git_diff', 'git_log', 'bash', 'load_skill', 'spawn_subagent', 'collect_subagent', 'submit_patch', 'request_clarification']);
        case 'verify':
          return new Set(['read_file', 'read_files', 'file_info', 'list_dir', 'search_text', 'search_files', 'git_status', 'git_diff', 'bash', 'submit_patch', 'request_clarification']);
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
  ): Promise<ParsedPlannerDecision> {
    const prompt = [
      task.sharedContext ? `Shared context:\n${task.sharedContext}` : '',
      `User request:\n${task.prompt}`,
    ].filter(Boolean).join('\n\n');
    try {
      const content = await this.callModelText(prompt, PLANNER_SYSTEM_PROMPT, conversationHistory, task, 'planner');
      return parsePlannerDecision(content, task.prompt);
    } catch {
      return fallbackPlannerDecision(task.prompt);
    }
  }

  private createToolContext(task: PromptTask): ToolContext {
    const policy = task.readOnly ? readOnlyPolicy(this.basePolicy) : clonePolicy(this.basePolicy);
    if (!task.readOnly && task.artifactDir && !policy.allowedWriteRoots.includes(task.artifactDir)) {
      policy.allowedWriteRoots.push(task.artifactDir);
    }
    if (task.artifactDir && !policy.allowedReadRoots.includes(task.artifactDir)) {
      policy.allowedReadRoots.push(task.artifactDir);
    }
    return {
      workspaceRoot: policy.workspaceRoot,
      spawnSubagent: (prompt) => this.spawnSubagent(prompt, task.taskId, Boolean(task.readOnly)),
      collectSubagent: (id) => this.collectSubagent(id),
      requestClarification: (question, choices) => this.requestClarification(task.taskId, question, choices),
      submitPatch: (patch) => this.submitPatch(task.taskId, patch),
      acquireWriteLock: (path) => this.fileLocks.acquire(path),
      policy,
      sharedContext: task.sharedContext,
      artifactDir: task.artifactDir,
      taskId: task.taskId,
    };
  }

  private getToolsForTask(readOnly: boolean) {
    if (!readOnly) {
      const blocked = new Set(['write_file', 'edit_file']);
      return WORKER_TOOLS.filter((tool) => !blocked.has(tool.function.name));
    }
    const blocked = new Set(['write_file', 'edit_file', 'submit_patch']);
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
      if (toolCtx.taskId && this.taskControllers.get(toolCtx.taskId)?.signal.aborted) return;
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
        if (toolCtx.taskId && this.taskControllers.get(toolCtx.taskId)?.signal.aborted) return;
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
