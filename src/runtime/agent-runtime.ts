import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { chatStream, type BackendConfig, type ChatChunk } from '../backend.js';
import type {
  AgentEvent,
  AgentInstance,
  AgentMailboxMessage,
  AgentModelMessage,
  ModelUsage,
  AgentSession,
  AgentSpec,
  PersistedAgentSession,
  SessionMessage,
} from '../domain/agent.js';
import { executeTool, getToolPolicy, toolRegistry } from '../infra/tools.js';
import type { ToolDefinition } from '../tools/types.js';
import { AgentRegistry, loadWorkspaceContext, matchesAgentSelector } from './agent-registry.js';
import { AgentRuntimeStore } from './agent-store.js';
import { FileLockManager } from './locks.js';
import { recordTimeline } from './session-timeline.js';

const WORKSPACE_CONTEXT_LABEL = 'AGENTS.md';

type ModelStream = (
  config: BackendConfig,
  systemPrompt: string,
  messages: AgentModelMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
) => AsyncGenerator<ChatChunk>;

export interface AgentRuntimeOptions {
  registry?: AgentRegistry;
  store?: AgentRuntimeStore;
  workspaceRoot?: string;
  defaultModel?: string;
  resolveModel: (alias?: string) => BackendConfig;
  modelStream?: ModelStream;
  maxConcurrentTurns?: number;
  maxAgentDepth?: number;
  maxChildrenPerTurn?: number;
  /** Maximum model/tool steps per turn. Main defaults to 64, child agents to 48. */
  maxSteps?: number;
  /** Optional AGENTS.md-style project context injected into every agent's system prompt. When omitted it is loaded from the workspace root. */
  projectContext?: string;
}

function now(): string {
  return new Date().toISOString();
}

function mergeUsage(previous: ModelUsage | undefined, next: ModelUsage): ModelUsage {
  const result: ModelUsage = { ...(previous ?? {}) };
  for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cachedInputTokens', 'cacheCreationInputTokens'] as const) {
    if (next[key] !== undefined) result[key] = (result[key] ?? 0) + next[key]!;
  }
  return result;
}

function asidePrefix(): string {
  return 'Additional context noted earlier (btw):';
}

function mergeAgentUsage(previous: AgentInstance['usage'], usage: ModelUsage | undefined, firstTokenMs: number | undefined, durationMs: number, requests = 1): AgentInstance['usage'] {
  const merged = mergeUsage(previous, usage ?? {});
  return { ...merged, requests: (previous?.requests ?? 0) + requests, turns: (previous?.turns ?? 0) + 1, firstTokenMs, lastTurnMs: durationMs };
}

function sessionChildren(instances: Map<string, AgentInstance>, parentId: string): AgentInstance[] {
  return [...instances.values()].filter((instance) => instance.parentInstanceId === parentId);
}

/** Tools whose success constitutes real progress (state changed on disk). */
const PROGRESS_TOOLS = new Set(['edit_file', 'write_file']);

// ── Context compaction ───────────────────────────────────────────────────────

const COMPACT_SYSTEM_PROMPT = 'You are a context compaction assistant. Produce a faithful, information-dense digest of the archived conversation so a coding agent can continue the work without the original messages. Never invent facts; keep file paths, ids, decisions, and pending work exact.';
const DEFAULT_COMPACT_KEEP_RECENT = 12;
const COMPACT_MIN_ARCHIVED_MESSAGES = 6;
const AUTO_COMPACT_MIN_MESSAGES = 12;
const DEFAULT_AUTO_COMPACT_RATIO = 0.75;
const SUMMARY_MESSAGE_SNIPPET_LIMIT = 4000;

function messageSize(message: AgentModelMessage): number {
  return String(message.content ?? '').length
    + JSON.stringify(message.tool_calls ?? []).length
    + JSON.stringify(message.responseItems ?? []).length;
}

function formatMessageForSummary(index: number, message: AgentModelMessage): string {
  const header = `[message ${index + 1}] ${message.role}`;
  const parts: string[] = [];
  if (message.content) parts.push(String(message.content).slice(0, SUMMARY_MESSAGE_SNIPPET_LIMIT));
  if (message.tool_calls?.length) {
    parts.push(message.tool_calls.map((call) => `tool call ${call.function.name}(${String(JSON.stringify(call.function.arguments ?? {})).slice(0, 2000)})`).join('\n'));
  }
  if (message.role === 'tool' && message.tool_use_id) parts.push(`(tool result for ${message.tool_use_id})`);
  return parts.length ? `${header}\n${parts.join('\n')}` : header;
}

function cloneInstance(instance: AgentInstance): AgentInstance {
  return {
    ...instance,
    messages: instance.messages.map((message) => ({
      ...message,
      tool_calls: message.tool_calls?.map((call) => ({
        ...call,
        function: { ...call.function, arguments: { ...call.function.arguments } },
      })),
    })),
    mailbox: instance.mailbox.map((message) => ({ ...message })),
    childInstanceIds: [...instance.childInstanceIds],
  };
}

function cloneSession(session: AgentSession): AgentSession {
  return { ...session, timeline: session.timeline?.map(entry => ({ ...entry })), messages: session.messages.map((message) => ({ ...message })), instanceIds: [...session.instanceIds] };
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [value];
  } catch {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function toolDefinition(
  name: string,
  description: string,
  properties: Record<string, { type: string; description?: string; items?: { type: string } }>,
  required: string[],
): ToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const AGENT_TOOL_DEFINITIONS: ToolDefinition[] = [
  toolDefinition('spawn_agent', 'Start an allowed agent instance asynchronously and return its instance id.', {
    agent: { type: 'string', description: 'Agent id from the available agent catalog.' },
    message: { type: 'string', description: 'Self-contained request for the agent.' },
  }, ['agent', 'message']),
  toolDefinition('send_agent', 'Send a follow-up, correction, or result to an existing related agent instance.', {
    instance_id: { type: 'string', description: 'Target agent instance id.' },
    message: { type: 'string', description: 'Message to deliver.' },
  }, ['instance_id', 'message']),
  toolDefinition('wait_agent', 'Wait for one or more related agent instances to become idle, fail, or be cancelled.', {
    instance_ids: { type: 'array', description: 'Agent instance ids.', items: { type: 'string' } },
    timeout_ms: { type: 'number', description: 'Maximum wait, default 60000 and maximum 300000.' },
  }, ['instance_ids']),
  toolDefinition('cancel_agent', 'Cancel a related agent instance.', {
    instance_id: { type: 'string', description: 'Target agent instance id.' },
  }, ['instance_id']),
];

const COMPACT_TOOL_DEFINITIONS: ToolDefinition[] = [
  toolDefinition('compact_context', 'Compact the conversation context of this agent (default) or a descendant agent instance: older messages are replaced by a model-generated digest, the original messages are archived, and the digest stays in context. Use after completing a major milestone to free context for the next phase.', {
    instance_id: { type: 'string', description: 'Target agent instance id. Omit to compact your own context.' },
    focus: { type: 'string', description: 'What the digest should emphasize (goals, decisions, file changes, pending work). Omit for a general digest.' },
    keep_recent: { type: 'number', description: 'Approximate number of recent messages to keep verbatim. Default 12.' },
  }, []),
  toolDefinition('search_history', 'Search the archived (compacted-away) context of this agent (default) or a descendant agent instance. Use this to recall details that were summarized out of context.', {
    query: { type: 'string', description: 'Case-insensitive text to search for.' },
    instance_id: { type: 'string', description: 'Target agent instance id. Omit to search your own archives.' },
    limit: { type: 'number', description: 'Maximum number of matches to return. Default 8.' },
  }, ['query']),
];

export class AgentRuntime {
  readonly registry: AgentRegistry;
  private readonly store: AgentRuntimeStore;
  private readonly workspaceRoot: string;
  private readonly resolveModel: (alias?: string) => BackendConfig;
  private readonly modelStream: ModelStream;
  private readonly maxConcurrentTurns: number;
  private readonly maxAgentDepth: number;
  private readonly maxChildrenPerTurn: number;
  private readonly maxSteps?: number;
  private projectContext?: string;
  private readonly readVersions = new Map<string, Map<string, string>>();
  private readonly failureCounts = new Map<string, Map<string, number>>();
  private defaultModel?: string;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly instances = new Map<string, AgentInstance>();
  private readonly subscribers = new Set<(event: AgentEvent) => void>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly activeTurns = new Set<string>();
  private readonly running = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly fileLocks = new FileLockManager();
  private readonly ready: Promise<void>;
  private shuttingDown = false;

  constructor(options: AgentRuntimeOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    this.registry = options.registry ?? new AgentRegistry({ workspaceRoot: this.workspaceRoot });
    this.store = options.store ?? new AgentRuntimeStore();
    this.resolveModel = options.resolveModel;
    this.defaultModel = options.defaultModel;
    this.modelStream = options.modelStream ?? ((config, system, messages, tools, signal) => (
      chatStream(config, system, messages, tools, signal)
    ));
    this.maxConcurrentTurns = Math.max(1, options.maxConcurrentTurns ?? Number(process.env.AGENT_MAX_CONCURRENT_TURNS ?? 4));
    this.maxAgentDepth = Math.max(1, options.maxAgentDepth ?? Number(process.env.AGENT_MAX_DEPTH ?? 4));
    this.maxChildrenPerTurn = Math.max(1, options.maxChildrenPerTurn ?? Number(process.env.AGENT_MAX_CHILDREN_PER_TURN ?? 3));
    this.maxSteps = options.maxSteps;
    const contextPromise = options.projectContext !== undefined
      ? Promise.resolve(options.projectContext)
      : loadWorkspaceContext(this.workspaceRoot);
    this.ready = Promise.all([this.registry.load(), this.store.init(), contextPromise]).then(([, , context]) => {
      this.projectContext = context;
      this.validateSpecs();
    });
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private emit(event: AgentEvent): void {
    const sessionId = 'sessionId' in event ? event.sessionId : 'instance' in event ? event.instance.sessionId : 'instanceId' in event && event.instanceId ? this.instances.get(event.instanceId)?.sessionId : undefined;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (session) recordTimeline(session, event);
    for (const listener of this.subscribers) {
      try { listener(event); } catch { /* subscribers cannot break the runtime */ }
    }
  }

  setDefaultModel(alias?: string): void {
    this.defaultModel = alias;
  }

  async setSessionDefaultModel(sessionId: string, alias?: string): Promise<void> {
    if (!this.sessions.has(sessionId)) await this.openSession(sessionId);
    const session = this.sessions.get(sessionId)!;
    session.defaultModel = alias;
    session.updatedAt = now();
    await this.persistSession(sessionId);
  }

  async reloadAgentSpecs(): Promise<void> {
    await this.registry.load();
    this.validateSpecs();
  }

  listAgentSpecs(): AgentSpec[] {
    return this.registry.list();
  }

  async openSession(sessionId = `session-${Date.now()}`): Promise<AgentSession> {
    await this.ready;
    const current = this.sessions.get(sessionId);
    if (current) return cloneSession(current);
    const persisted = await this.store.load(sessionId);
    if (persisted) {
      const session = persisted.session;
      this.sessions.set(sessionId, session);
      for (const instance of persisted.instances) {
        if (instance.status === 'running' || instance.status === 'queued' || instance.status === 'waiting') {
          instance.status = instance.mailbox.some((message) => message.status === 'pending') ? 'queued' : 'idle';
          instance.activeTurnId = undefined;
        }
        this.instances.set(instance.instanceId, instance);
      }
      for (const instance of persisted.instances.filter((item) => item.status === 'queued')) this.enqueue(instance.instanceId);
      this.emit({ type: 'session_opened', session: cloneSession(session) });
      return cloneSession(session);
    }

    if (!this.registry.get('main')) throw new Error('No main agent spec found');
    const createdAt = now();
    const main = this.newInstance(sessionId, 'main', undefined, 0, createdAt);
    const session: AgentSession = {
      sessionId,
      mainInstanceId: main.instanceId,
      defaultModel: this.defaultModel,
      messages: [],
      instanceIds: [main.instanceId],
      createdAt,
      updatedAt: createdAt,
    };
    this.sessions.set(sessionId, session);
    this.instances.set(main.instanceId, main);
    await this.persistSession(sessionId);
    this.emit({ type: 'session_opened', session: cloneSession(session) });
    this.emit({ type: 'instance_created', instance: cloneInstance(main) });
    return cloneSession(session);
  }

  getSession(sessionId: string): AgentSession | undefined {
    const session = this.sessions.get(sessionId);
    return session ? cloneSession(session) : undefined;
  }

  getInstance(instanceId: string): AgentInstance | undefined {
    const instance = this.instances.get(instanceId);
    return instance ? cloneInstance(instance) : undefined;
  }

  listInstances(sessionId: string): AgentInstance[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.instanceIds.map((id) => this.instances.get(id)).filter((item): item is AgentInstance => Boolean(item)).map(cloneInstance);
  }

  async listSessions(): Promise<Array<{ sessionId: string; messages: number; updatedAt: string }>> {
    await this.ready;
    return this.store.list();
  }

  async removeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    for (const id of session?.instanceIds ?? []) {
      this.controllers.get(id)?.abort('Session removed');
      this.instances.delete(id);
      this.queued.delete(id);
    }
    this.sessions.delete(sessionId);
    await this.store.remove(sessionId);
  }

  async clearSession(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) await this.openSession(sessionId);
    await this.cancelSession(sessionId);
    const session = this.sessions.get(sessionId)!;
    session.messages = [];
    session.timeline = [];
    session.pendingAsides = [];
    session.goal = undefined;
    session.updatedAt = now();
    const main = this.instances.get(session.mainInstanceId);
    if (main) {
      this.controllers.get(main.instanceId)?.abort('Conversation cleared');
      main.messages = [];
      main.mailbox = [];
      main.status = 'idle';
      main.compactionCount = 0;
      main.lastError = undefined;
      main.lastOutput = undefined;
      main.updatedAt = now();
    }
    await this.persistSession(sessionId);
  }

  async cancelSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const id of session.instanceIds) {
      const instance = this.instances.get(id);
      if (!instance) continue;
      this.controllers.get(id)?.abort('Stopped by user');
      this.queued.delete(id);
      instance.mailbox.forEach((message) => { message.status = 'delivered'; });
      instance.status = 'cancelled';
      instance.activeTurnId = undefined;
      instance.updatedAt = now();
      this.emit({ type: 'instance_updated', instance: cloneInstance(instance) });
    }
    await this.persistSession(sessionId);
    this.notifyIdleWaiters();
  }

  /** Queue an aside (/btw): folds into the next submitted message without starting a turn. */
  async addAside(sessionId: string, content: string): Promise<{ queued: boolean; detail: string }> {
    const text = content.trim();
    if (!text) throw new Error('Aside cannot be empty');
    await this.openSession(sessionId);
    const session = this.sessions.get(sessionId)!;
    const hadAsides = (session.pendingAsides?.length ?? 0) > 0;
    (session.pendingAsides ??= []).push(text);
    session.updatedAt = now();
    await this.persistSession(sessionId);
    this.emit({ type: 'system_message', sessionId, message: { messageId: randomUUID(), role: 'system', content: hadAsides
      ? `Noted — another aside is already queued; both will be included with your next message.`
      : `Noted. This will be included with your next message without starting a turn.`, createdAt: now() } });
    return { queued: true, detail: hadAsides
      ? 'Queued behind one earlier aside; both will be included with the next message.'
      : 'Queued. It will be included with the next message without starting a turn.' };
  }

  /** Set or clear the standing session goal (/goal). Injected into every agent's prompt until cleared. */
  async setSessionGoal(sessionId: string, goal: string): Promise<{ set: boolean; detail: string }> {
    const text = goal.trim();
    await this.openSession(sessionId);
    const session = this.sessions.get(sessionId)!;
    session.goal = text || undefined;
    session.updatedAt = now();
    await this.persistSession(sessionId);
    this.emit({ type: 'system_message', sessionId, message: { messageId: randomUUID(), role: 'system',
      content: text ? `Session goal set: ${text}` : 'Session goal cleared.', createdAt: now() } });
    return { set: Boolean(text), detail: text ? `Goal set. It now applies to every agent in this session: ${text}` : 'Goal cleared.' };
  }

  async submitMessage(sessionId: string, content: string): Promise<string> {
    const text = content.trim();
    if (!text) throw new Error('Message cannot be empty');
    await this.openSession(sessionId);
    const session = this.sessions.get(sessionId)!;
    const main = this.instances.get(session.mainInstanceId)!;
    const turnId = randomUUID();
    const queuedAsides = session.pendingAsides ?? [];
    session.pendingAsides = [];
    const composed = queuedAsides.length
      ? `${text}

${asidePrefix()}
${queuedAsides.map((aside, index) => `${index + 1}. ${aside}`).join('\n')}`
      : text;
    const message: SessionMessage = { messageId: randomUUID(), role: 'user', content: composed, createdAt: now(), turnId };
    session.messages.push(message);
    session.updatedAt = message.createdAt;
    if (main.status === 'running' || main.status === 'waiting') {
      this.controllers.get(main.instanceId)?.abort('Superseded by a newer user message');
    }
    if (main.status === 'cancelled') main.status = 'idle';
    // The model must see the folded asides, so deliver the composed message.
    // The TUI renders the asides as separate system entries from the emitted
    // system_message events above, while this user message keeps them inline.
    this.deliver(main, composed, undefined, turnId);
    await this.persistSession(sessionId);
    this.emit({ type: 'user_message', sessionId, message: { ...message } });
    if (queuedAsides.length) {
      // Timeline-only notices; the user message itself already carries the
      // asides inline for the model.
      this.emit({ type: 'system_message', sessionId, message: { messageId: randomUUID(), role: 'system', content: `Aside${queuedAsides.length > 1 ? 's' : ''} included with your message:`, createdAt: now() } });
      for (const aside of queuedAsides) {
        this.emit({ type: 'system_message', sessionId, message: { messageId: randomUUID(), role: 'system', content: `· ${aside}`, createdAt: now() } });
      }
    }
    this.enqueue(main.instanceId);
    return turnId;
  }

  async spawnAgent(fromInstanceId: string, agentId: string, message: string): Promise<string> {
    const parent = this.instances.get(fromInstanceId);
    if (!parent) throw new Error(`Agent instance ${fromInstanceId} not found`);
    const parentSpec = this.registry.get(parent.agentId);
    if (!parentSpec || !this.registry.canCall(parentSpec, agentId)) throw new Error(`Agent ${parent.agentId} cannot call ${agentId}`);
    if (!message.trim()) throw new Error('Agent message cannot be empty');
    if (parent.depth + 1 > this.maxAgentDepth) throw new Error(`Maximum agent depth ${this.maxAgentDepth} exceeded`);
    const ancestors = this.ancestorAgentIds(parent);
    if (ancestors.has(agentId)) throw new Error(`Agent call cycle rejected: ${agentId} already exists in the ancestor chain`);
    const turnId = parent.activeTurnId;
    const childrenThisTurn = sessionChildren(this.instances, parent.instanceId).filter((child) => child.parentTurnId === turnId).length;
    if (childrenThisTurn >= this.maxChildrenPerTurn) throw new Error(`Maximum of ${this.maxChildrenPerTurn} child agents per turn reached; reuse an existing agent or continue directly.`);
    const session = this.sessions.get(parent.sessionId)!;
    const child = this.newInstance(parent.sessionId, agentId, parent.instanceId, parent.depth + 1);
    child.parentTurnId = turnId;
    this.instances.set(child.instanceId, child);
    parent.childInstanceIds.push(child.instanceId);
    parent.updatedAt = now();
    session.instanceIds.push(child.instanceId);
    session.updatedAt = now();
    this.deliver(child, message, parent.instanceId);
    await this.persistSession(session.sessionId);
    this.emit({ type: 'instance_created', instance: cloneInstance(child) });
    this.emit({ type: 'instance_updated', instance: cloneInstance(parent) });
    this.enqueue(child.instanceId);
    return child.instanceId;
  }

  async sendAgent(fromInstanceId: string, targetInstanceId: string, message: string): Promise<void> {
    const from = this.instances.get(fromInstanceId);
    const target = this.instances.get(targetInstanceId);
    if (!from || !target || from.sessionId !== target.sessionId) throw new Error('Related agent instance not found');
    if (!message.trim()) throw new Error('Agent message cannot be empty');
    const directlyRelated = from.parentInstanceId === target.instanceId || target.parentInstanceId === from.instanceId;
    const canCallTarget = this.registry.canCall(from.agentId, target.agentId);
    if (!directlyRelated && !canCallTarget) throw new Error(`Agent ${from.agentId} cannot message ${target.agentId}`);
    if (target.status === 'cancelled') throw new Error('Target agent instance is cancelled');
    if (target.status === 'running' || target.status === 'waiting') this.controllers.get(target.instanceId)?.abort('Agent sent a newer message');
    this.deliver(target, message, from.instanceId);
    await this.persistSession(target.sessionId);
    this.enqueue(target.instanceId);
  }

  async cancelAgent(requesterId: string, targetId: string): Promise<void> {
    const requester = this.instances.get(requesterId);
    const target = this.instances.get(targetId);
    if (!requester || !target || requester.sessionId !== target.sessionId) throw new Error('Related agent instance not found');
    const related = requester.instanceId === target.parentInstanceId || requester.parentInstanceId === target.instanceId;
    if (!related && !this.registry.canCall(requester.agentId, target.agentId)) throw new Error('Cannot cancel unrelated agent instance');
    this.controllers.get(targetId)?.abort('Cancelled by related agent');
    target.status = 'cancelled';
    target.activeTurnId = undefined;
    target.updatedAt = now();
    this.queued.delete(targetId);
    await this.persistSession(target.sessionId);
    this.emit({ type: 'instance_updated', instance: cloneInstance(target) });
    this.notifyIdleWaiters();
  }

  async waitForAgents(requesterId: string, ids: string[], timeoutMs = 60_000): Promise<string> {
    const requester = this.instances.get(requesterId);
    if (!requester) throw new Error('Requesting agent instance not found');
    const targets = ids.map((id) => this.instances.get(id));
    if (targets.some((target) => !target || target.sessionId !== requester.sessionId)) throw new Error('Related agent instance not found');
    const done = (): boolean => targets.every((target) => target && ['idle', 'failed', 'cancelled'].includes(target.status));
    const signal = this.controllers.get(requesterId)?.signal;
    if (!done()) {
      requester.status = 'waiting';
      this.emit({ type: 'instance_updated', instance: cloneInstance(requester) });
      // Waiting on mailboxes consumes no model/tool capacity. Yield this slot
      // so all requested siblings can run even when their count reaches the
      // global concurrency limit.
      const yieldedCapacity = this.running.delete(requester.instanceId);
      if (yieldedCapacity) this.pump();
      await new Promise<void>((resolveWait) => {
        const finish = (): void => {
          clearTimeout(timeout);
          this.idleWaiters.delete(check);
          signal?.removeEventListener('abort', finish);
          resolveWait();
        };
        const timeout = setTimeout(finish, Math.min(Math.max(timeoutMs, 100), 300_000));
        const check = (): void => {
          if (!done()) return;
          finish();
        };
        this.idleWaiters.add(check);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
      if (signal?.aborted) return 'Wait cancelled.';
      if (yieldedCapacity) {
        const hasCapacity = (): boolean => !requester.parentInstanceId || this.backgroundRunning() < this.maxConcurrentTurns;
        while (!hasCapacity() && !signal?.aborted) {
          await new Promise<void>((resolveCapacity) => {
            const finish = (): void => {
              this.idleWaiters.delete(check);
              signal?.removeEventListener('abort', finish);
              resolveCapacity();
            };
            const check = (): void => {
              if (hasCapacity()) finish();
            };
            this.idleWaiters.add(check);
            signal?.addEventListener('abort', finish, { once: true });
            if (signal?.aborted) finish();
          });
        }
        if (signal?.aborted) return 'Wait cancelled.';
        this.running.add(requester.instanceId);
      }
      if (requester.status === 'waiting') requester.status = 'running';
    }
    const waited = new Set(ids);
    for (const message of requester.mailbox) {
      if (message.status === 'pending' && message.fromInstanceId && waited.has(message.fromInstanceId)) {
        message.status = 'delivered';
      }
    }
    return JSON.stringify(targets.map((target) => ({
      instanceId: target!.instanceId,
      agentId: target!.agentId,
      status: target!.status,
      output: target!.lastOutput,
      error: target!.lastError,
    })));
  }

  async waitForIdle(sessionId: string, timeoutMs = 300_000): Promise<void> {
    const idle = (): boolean => {
      const session = this.sessions.get(sessionId);
      return !session || session.instanceIds.every((id) => {
        const instance = this.instances.get(id);
        return instance && ['idle', 'failed', 'cancelled'].includes(instance.status)
          && !this.running.has(id) && !this.queued.has(id);
      });
    };
    if (idle()) return;
    await new Promise<void>((resolveWait, reject) => {
      const timeout = setTimeout(() => { this.idleWaiters.delete(check); reject(new Error('Timed out waiting for agent runtime')); }, timeoutMs);
      const check = (): void => {
        if (!idle()) return;
        clearTimeout(timeout);
        this.idleWaiters.delete(check);
        resolveWait();
      };
      this.idleWaiters.add(check);
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const controller of this.controllers.values()) controller.abort('Runtime shutdown');
    for (const sessionId of this.sessions.keys()) await this.persistSession(sessionId);
    await this.store.flush();
  }

  private newInstance(sessionId: string, agentId: string, parentInstanceId?: string, depth = 0, createdAt = now()): AgentInstance {
    if (!this.registry.get(agentId)) throw new Error(`Agent spec ${agentId} not found`);
    return {
      instanceId: randomUUID(), sessionId, agentId, parentInstanceId, depth,
      status: 'idle', messages: [], mailbox: [], childInstanceIds: [], createdAt, updatedAt: createdAt,
    };
  }

  private validateSpecs(): void {
    const specs = this.registry.list();
    for (const spec of specs) {
      for (const tool of spec.tools) {
        if (tool !== '*' && !toolRegistry.has(tool)) throw new Error(`Agent spec ${spec.source} references unknown tool "${tool}"`);
      }
      for (const selector of spec.agents) {
        if (selector !== '*' && !selector.endsWith('/*')
          && !specs.some((candidate) => candidate.id !== spec.id && matchesAgentSelector(candidate.id, selector))) {
          throw new Error(`Agent spec ${spec.source} references an agent selector with no matches: "${selector}"`);
        }
      }
    }
  }

  private ancestorAgentIds(instance: AgentInstance): Set<string> {
    const ids = new Set<string>([instance.agentId]);
    let parentId = instance.parentInstanceId;
    while (parentId) {
      const parent = this.instances.get(parentId);
      if (!parent) break;
      ids.add(parent.agentId);
      parentId = parent.parentInstanceId;
    }
    return ids;
  }

  private deliver(target: AgentInstance, content: string, fromInstanceId?: string, turnId?: string): void {
    const message: AgentMailboxMessage = { messageId: randomUUID(), fromInstanceId, turnId, content, createdAt: now(), status: 'pending' };
    target.mailbox.push(message);
    target.updatedAt = message.createdAt;
    if (target.status !== 'cancelled' && !this.activeTurns.has(target.instanceId)) target.status = 'queued';
    this.emit({ type: 'mailbox_message', instanceId: target.instanceId, message: { ...message } });
    this.emit({ type: 'instance_updated', instance: cloneInstance(target) });
  }

  private enqueue(instanceId: string): void {
    if (this.shuttingDown || this.activeTurns.has(instanceId) || this.queued.has(instanceId)) return;
    const instance = this.instances.get(instanceId);
    if (!instance || instance.status === 'cancelled') return;
    this.queue.push(instanceId);
    this.queued.add(instanceId);
    queueMicrotask(() => this.pump());
  }

  private backgroundRunning(): number {
    return [...this.running].filter((id) => this.instances.get(id)?.parentInstanceId).length;
  }

  private pump(): void {
    while (!this.shuttingDown && this.queue.length) {
      // User-facing entry instances have a separate lane: busy workers must
      // never keep a new user message queued behind long-running work.
      const mainIndex = this.queue.findIndex((id) => {
        const candidate = this.instances.get(id);
        return candidate && !candidate.parentInstanceId;
      });
      if (mainIndex < 0 && this.backgroundRunning() >= this.maxConcurrentTurns) break;
      const id = this.queue.splice(mainIndex >= 0 ? mainIndex : 0, 1)[0]!;
      this.queued.delete(id);
      const instance = this.instances.get(id);
      if (!instance || instance.status === 'cancelled' || this.activeTurns.has(id)) continue;
      this.activeTurns.add(id);
      this.running.add(id);
      void this.runTurn(instance).finally(() => {
        this.activeTurns.delete(id);
        this.running.delete(id);
        this.controllers.delete(id);
        if (instance.status !== 'cancelled' && instance.mailbox.some((message) => message.status === 'pending')) this.enqueue(id);
        this.notifyIdleWaiters();
        this.pump();
      });
    }
  }

  private absorbMailbox(instance: AgentInstance): void {
    const pending = instance.mailbox.filter((message) => message.status === 'pending');
    for (const message of pending) {
      message.status = 'delivered';
      let prefix = 'User message';
      if (message.fromInstanceId) {
        const from = this.instances.get(message.fromInstanceId);
        prefix = from ? `Message from ${from.agentId} (${from.instanceId.slice(0, 8)})` : 'Message from another agent';
      }
      instance.messages.push({ role: 'user', content: `${prefix}:\n${message.content}` });
    }
  }

  private systemPrompt(instance: AgentInstance, spec: AgentSpec): string {
    const catalog = this.registry.allowedAgents(spec);
    // Keep the system prefix stable between model calls. Injecting every sibling's
    // live status here invalidates provider prompt caches and burns input tokens;
    // child results are delivered through the mailbox and remain visible in the
    // normal conversation context.
    const session = this.sessions.get(instance.sessionId);
    return [
      spec.instructions,
      ...(session?.goal ? ['', `Standing goal for this session (highest priority; stay aligned with it unless the user says otherwise):`, session.goal] : []),
      ...(this.projectContext ? ['', `Project context (${WORKSPACE_CONTEXT_LABEL}):`, this.projectContext] : []),
      '',
      'Runtime contract:',
      `- You are agent "${spec.id}" in workspace ${this.workspaceRoot}.`,
      '- Decide your own next step from your spec, messages, tools, and available agent catalog.',
      '- Do not invent agent ids. Agent calls outside the catalog are rejected.',
      '- Keep agent messages self-contained because child agents do not receive your full conversation.',
      instance.parentInstanceId
        ? '- Your output is private to the parent agent. Report concise progress and results; never address the end user directly.'
        : '- You are the session entry instance. Your natural-language output is shown directly to the user.',
      catalog.length
        ? `Available agents:\n${catalog.map((agent) => `- ${agent.id}: ${agent.description}`).join('\n')}`
        : 'Available agents: none.',
      'Existing instances are communicated through mailbox messages. Reuse an existing related agent when possible; do not spawn duplicates.',
    ].join('\n');
  }

  private toolsFor(instance: AgentInstance, spec: AgentSpec): ToolDefinition[] {
    const requested = spec.tools.includes('*')
      ? toolRegistry.definitions().map((definition) => definition.function.name)
      : spec.tools;
    const tools = requested
      .map((name) => toolRegistry.get(name)?.definition)
      .filter((definition): definition is ToolDefinition => Boolean(definition));
    if (spec.agents.length > 0 && this.registry.allowedAgents(spec).length > 0) {
      tools.push(...AGENT_TOOL_DEFINITIONS);
    }
    tools.push(...COMPACT_TOOL_DEFINITIONS);
    return tools;
  }

  private trimMessages(messages: AgentModelMessage[], config: BackendConfig): AgentModelMessage[] {
    const budgetChars = this.contextBudgetChars(config);
    let total = 0;
    const kept: AgentModelMessage[] = [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      const size = messageSize(message);
      if (kept.length && total + size > budgetChars) break;
      kept.unshift(message);
      total += size;
    }
    // Tool results must never be sent without their assistant tool-call message.
    while (kept[0]?.role === 'tool') kept.shift();
    return kept;
  }

  private contextBudgetChars(config: BackendConfig): number {
    return Math.max(16_000, Math.floor((config.contextWindow ?? 131_072) * 4 * 0.72));
  }

  private shouldAutoCompact(messages: AgentModelMessage[], config: BackendConfig): boolean {
    if (messages.length < AUTO_COMPACT_MIN_MESSAGES) return false;
    const size = messages.reduce((total, message) => total + messageSize(message), 0);
    const ratio = Number(process.env.AGENT_AUTO_COMPACT_RATIO ?? DEFAULT_AUTO_COMPACT_RATIO);
    return size > this.contextBudgetChars(config) * ratio;
  }

  /**
   * Index where the kept tail must start: at or after `keepRecent` messages back,
   * advanced to the next `user` message so the tail never begins with a tool
   * result detached from its assistant tool-call message.
   */
  private compactBoundary(messages: AgentModelMessage[], keepRecent: number): number {
    const start = Math.max(0, messages.length - Math.max(1, keepRecent));
    for (let index = start; index < messages.length; index += 1) {
      if (messages[index]!.role === 'user') return index;
    }
    return messages.length;
  }

  private async compactInstanceMessages(
    instance: AgentInstance,
    config: BackendConfig,
    options: { focus?: string; keepRecent?: number; reason: 'auto' | 'manual' },
    signal?: AbortSignal,
  ): Promise<{ compacted: boolean; detail: string }> {
    delete instance.pendingCompact;
    const keepRecent = Math.max(1, Math.floor(options.keepRecent ?? DEFAULT_COMPACT_KEEP_RECENT));
    const boundary = this.compactBoundary(instance.messages, keepRecent);
    const archived = instance.messages.slice(0, boundary);
    const tail = instance.messages.slice(boundary);
    if (archived.length < COMPACT_MIN_ARCHIVED_MESSAGES) {
      return { compacted: false, detail: `Context is too short to compact (need at least ${COMPACT_MIN_ARCHIVED_MESSAGES} older messages before the recent tail).` };
    }
    const charsBefore = instance.messages.reduce((total, message) => total + messageSize(message), 0);
    const transcript = archived
      .map((message, index) => formatMessageForSummary(index, message))
      .join('\n');
    const request = [
      'Summarize the following earlier conversation for a coding agent that will continue the work with only this digest in context.',
      'Preserve: the user goals, decisions made, files/paths touched with what changed, important tool results, open questions, and pending work.',
      options.focus?.trim() ? `Emphasize: ${options.focus.trim()}` : '',
      'Write the digest in the same language as the conversation. Be thorough but concise.',
      '',
      '<archived-conversation>',
      transcript,
      '</archived-conversation>',
    ].filter(Boolean).join('\n');

    let summary = '';
    for await (const chunk of this.modelStream(config, COMPACT_SYSTEM_PROMPT, [{ role: 'user', content: request }], [], signal)) {
      if (signal?.aborted) return { compacted: false, detail: 'Compaction cancelled.' };
      if (chunk.content) summary += chunk.content;
    }
    summary = summary.trim();
    if (!summary) return { compacted: false, detail: 'Compaction produced no summary; context left unchanged.' };

    const seq = (instance.compactionCount ?? 0) + 1;
    await this.store.saveArchive(instance.sessionId, instance.instanceId, seq, JSON.parse(JSON.stringify(archived)) as unknown[]);

    const digest: AgentModelMessage = {
      role: 'user',
      content: [
        `<context-digest instance="${instance.instanceId}" archive-seq="${seq}">`,
        'Earlier conversation was compacted. The original messages are archived and searchable with the search_history tool.',
        options.focus?.trim() ? `Focus requested: ${options.focus.trim()}` : '',
        '',
        summary,
        '</context-digest>',
      ].filter((line) => line !== undefined).join('\n'),
    };
    instance.messages = [digest, ...tail];
    instance.compactionCount = seq;
    instance.updatedAt = now();
    const charsAfter = instance.messages.reduce((total, message) => total + messageSize(message), 0);
    this.emit({
      type: 'context_compacted',
      sessionId: instance.sessionId,
      instanceId: instance.instanceId,
      agentId: instance.agentId,
      reason: options.reason,
      archivedMessages: archived.length,
      charsBefore,
      charsAfter,
    });
    this.emit({ type: 'instance_updated', instance: cloneInstance(instance) });
    await this.persistSession(instance.sessionId);
    return {
      compacted: true,
      detail: `Archived ${archived.length} older messages (archive seq ${seq}) and replaced them with a digest. Context shrank from ${charsBefore} to ${charsAfter} chars. Use search_history to recall archived details.`,
    };
  }

  private resolveConfigFor(instance: AgentInstance): BackendConfig {
    const session = this.sessions.get(instance.sessionId)!;
    const spec = this.registry.get(instance.agentId);
    return { ...this.resolveModel(spec?.model ?? session.defaultModel ?? this.defaultModel), sessionId: instance.sessionId };
  }

  private isSelfOrDescendant(fromInstanceId: string, targetInstanceId: string): boolean {
    if (fromInstanceId === targetInstanceId) return true;
    let current = this.instances.get(targetInstanceId);
    while (current?.parentInstanceId) {
      if (current.parentInstanceId === fromInstanceId) return true;
      current = this.instances.get(current.parentInstanceId);
    }
    return false;
  }

  /** Compact an instance on demand. Used by /compact and the compact_context tool for idle targets. */
  async compactInstance(instanceId: string, options: { focus?: string; keepRecent?: number; reason?: 'auto' | 'manual' } = {}): Promise<string> {
    await this.ready;
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Agent instance ${instanceId} not found`);
    if (instance.status === 'running' || instance.status === 'waiting') throw new Error('Agent is running. Stop it first (/cancel) or compact a descendant agent instead.');
    const result = await this.compactInstanceMessages(instance, this.resolveConfigFor(instance), { ...options, reason: options.reason ?? 'manual' });
    return result.detail;
  }

  /** Search archived (compacted-away) messages of an instance. */
  async searchArchivedContext(instanceId: string, query: string, limit = 8): Promise<string> {
    await this.ready;
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Agent instance ${instanceId} not found`);
    const needle = query.trim().toLowerCase();
    if (!needle) return 'Search query is empty.';
    const archives = await this.store.loadArchives(instance.sessionId, instance.instanceId);
    if (!archives.length) return 'No archived context yet — this instance has never been compacted.';
    const matches: string[] = [];
    for (const archive of archives) {
      for (let index = 0; index < archive.messages.length; index += 1) {
        const message = archive.messages[index]! as AgentModelMessage;
        const haystack = formatMessageForSummary(index, message).toLowerCase();
        const at = haystack.indexOf(needle);
        if (at === -1) continue;
        const label = message.role === 'tool' ? `tool result${message.tool_use_id ? ` for ${message.tool_use_id}` : ''}` : message.role;
        const content = String(message.content ?? (message.tool_calls ? JSON.stringify(message.tool_calls) : ''));
        const start = Math.max(0, Math.min(at - 120, content.length - 320));
        const snippet = `${start > 0 ? '…' : ''}${content.slice(start, start + 320)}${content.length > start + 320 ? '…' : ''}`;
        matches.push(`[archive seq ${archive.seq}, message ${index + 1}, ${label}]\n${snippet}`);
        if (matches.length >= Math.max(1, limit)) break;
      }
      if (matches.length >= Math.max(1, limit)) break;
    }
    if (!matches.length) return `No archived context matches ${JSON.stringify(query)}. ${archives.length} archive file(s) exist for this instance.`;
    return matches.join('\n\n');
  }

  private async runTurn(instance: AgentInstance): Promise<void> {
    const spec = this.registry.get(instance.agentId);
    if (!spec) {
      instance.status = 'failed';
      instance.lastError = `Agent spec ${instance.agentId} no longer exists`;
      return;
    }
    const session = this.sessions.get(instance.sessionId)!;
    const controller = new AbortController();
    const turnId = instance.mailbox.filter((message) => message.status === 'pending' && message.turnId).at(-1)?.turnId ?? randomUUID();
    instance.activeTurnId = turnId;
    instance.status = 'running';
    instance.updatedAt = now();
    this.failureCounts.delete(instance.instanceId);
    this.controllers.set(instance.instanceId, controller);
    this.absorbMailbox(instance);
    this.emit({ type: 'instance_updated', instance: cloneInstance(instance) });
    await this.persistSession(instance.sessionId);

    try {
      const config = { ...this.resolveModel(spec.model ?? session.defaultModel ?? this.defaultModel), sessionId: session.sessionId };
      if (!config.model) throw new Error('No model configured. Use /provider or /model first.');
      const tools = this.toolsFor(instance, spec);
      let finalOutput = '';
      const turnStartedAt = Date.now();
      let turnUsage: ModelUsage | undefined;
      let firstTokenMs: number | undefined;
      let requestCount = 0;
      const stepLimit = Math.max(1, this.maxSteps ?? (instance.parentInstanceId ? 48 : 64));
      for (let step = 0; step < stepLimit; step += 1) {
        if (controller.signal.aborted || instance.activeTurnId !== turnId) return;
        if (instance.pendingCompact || this.shouldAutoCompact(instance.messages, config)) {
          const reason = instance.pendingCompact?.reason ?? 'auto';
          try {
            await this.compactInstanceMessages(instance, config, {
              focus: instance.pendingCompact?.focus,
              keepRecent: instance.pendingCompact?.keepRecent,
              reason,
            }, controller.signal);
          } catch { /* Compaction is best-effort; trimMessages remains the fallback. */ }
        }
        const messages = this.trimMessages(instance.messages, config);
        requestCount += 1;
        let text = '';
        let thinking = '';
        const responseItems: Record<string, unknown>[] = [];
        const calls: NonNullable<AgentModelMessage['tool_calls']> = [];
        for await (const chunk of this.modelStream(config, this.systemPrompt(instance, spec), messages, tools, controller.signal)) {
          if (controller.signal.aborted || instance.activeTurnId !== turnId) return;
          if (chunk.responseItems) responseItems.push(...chunk.responseItems);
          if (chunk.thinking) {
            thinking += chunk.thinking;
            this.emit({ type: 'thinking_delta', sessionId: session.sessionId, instanceId: instance.instanceId, turnId, text: chunk.thinking });
          }
          if (chunk.content) {
            if (firstTokenMs === undefined) firstTokenMs = Date.now() - turnStartedAt;
            text += chunk.content;
            finalOutput += chunk.content;
            if (!instance.parentInstanceId) {
              this.emit({ type: 'assistant_delta', sessionId: session.sessionId, instanceId: instance.instanceId, turnId, text: chunk.content });
            }
          }
          if (chunk.usage) turnUsage = mergeUsage(turnUsage, chunk.usage);
          if (chunk.toolCalls?.length) calls.push(...chunk.toolCalls);
        }
        instance.messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}), ...(responseItems.length ? { responseItems } : {}) });
        if (text.trim() && !instance.parentInstanceId) {
          const visible: SessionMessage = { messageId: randomUUID(), role: 'assistant', content: text.trim(), createdAt: now(), turnId, ...(thinking ? { thinking } : {}) };
          session.messages.push(visible);
          session.updatedAt = visible.createdAt;
          this.emit({ type: 'assistant_message', sessionId: session.sessionId, instanceId: instance.instanceId, message: { ...visible } });
        }
        if (!calls.length) break;
        for (const call of calls) {
          const args = call.function.arguments as Record<string, unknown>;
          const input = JSON.stringify(args);
          this.emit({ type: 'tool_started', instanceId: instance.instanceId, turnId, tool: call.function.name, input });
          const output = await this.executeAgentTool(instance, call.function.name, args, controller.signal);
          if (controller.signal.aborted || instance.activeTurnId !== turnId) return;
          instance.messages.push({ role: 'tool', content: output, tool_use_id: call.id });
          this.emit({ type: 'tool_finished', instanceId: instance.instanceId, turnId, tool: call.function.name, output });
          const fingerprint = createHash('sha256')
            .update(call.function.name)
            .update('\0')
            .update(JSON.stringify(args))
            .update('\0')
            .update(output)
            .digest('hex');
          const failed = /^Error:/i.test(output) || /PolicyError/.test(output);
          if (failed) {
            // Progress, not recency, resets the failure chain: counts are kept
            // per fingerprint, so interleaved successful reads (which prove
            // nothing changed) cannot launder a repeating failure.
            const counts = this.failureCounts.get(instance.instanceId) ?? new Map<string, number>();
            const repeats = (counts.get(fingerprint) ?? 0) + 1;
            counts.set(fingerprint, repeats);
            this.failureCounts.set(instance.instanceId, counts);
            if (repeats >= 3) {
              throw new Error(`Doom loop detected: ${call.function.name} produced the same failure ${repeats} times without progress. Change approach or inspect the diagnostic before retrying.`);
            }
          } else if (PROGRESS_TOOLS.has(call.function.name)) {
            // Only a state-changing success (an actual write) counts as
            // progress; read-only successes leave the failure chain intact.
            this.failureCounts.delete(instance.instanceId);
          }
        }
        if (instance.pendingCompact && !controller.signal.aborted && instance.activeTurnId === turnId) {
          try {
            await this.compactInstanceMessages(instance, config, {
              focus: instance.pendingCompact.focus,
              keepRecent: instance.pendingCompact.keepRecent,
              reason: instance.pendingCompact.reason,
            }, controller.signal);
          } catch { /* Compaction is best-effort. */ }
        }
        if (step === stepLimit - 1) throw new Error(`Agent reached the ${stepLimit}-step safety limit. Review the activity and send a follow-up to continue.`);
      }
      if (controller.signal.aborted || instance.activeTurnId !== turnId) return;
      instance.lastOutput = finalOutput.trim() || instance.lastOutput;
      const endedAt = now();
      instance.usage = mergeAgentUsage(instance.usage, turnUsage, firstTokenMs, Date.now() - turnStartedAt, requestCount);
      instance.lastTurn = { startedAt: new Date(turnStartedAt).toISOString(), endedAt, durationMs: Date.now() - turnStartedAt, usage: turnUsage };
      instance.lastError = undefined;
      instance.status = 'idle';
      instance.activeTurnId = undefined;
      instance.updatedAt = now();
      if (instance.parentInstanceId && instance.lastOutput) {
        const parent = this.instances.get(instance.parentInstanceId);
        if (parent && parent.status !== 'cancelled') {
          this.deliver(parent, `${instance.agentId} (${instance.instanceId.slice(0, 8)}) finished this turn:\n${instance.lastOutput}`, instance.instanceId);
          this.enqueue(parent.instanceId);
        }
      }
    } catch (error) {
      if (controller.signal.aborted || instance.activeTurnId !== turnId) return;
      instance.status = 'failed';
      instance.lastError = error instanceof Error ? error.message : String(error);
      instance.activeTurnId = undefined;
      instance.updatedAt = now();
      this.emit({ type: 'runtime_error', sessionId: instance.sessionId, instanceId: instance.instanceId, error: instance.lastError });
      if (instance.parentInstanceId) {
        const parent = this.instances.get(instance.parentInstanceId);
        if (parent) {
          this.deliver(parent, `${instance.agentId} failed: ${instance.lastError}`, instance.instanceId);
          this.enqueue(parent.instanceId);
        }
      }
    } finally {
      // Interrupted tool batches still need matching results in the next request.
      let lastAssistant = instance.messages.length - 1;
      while (lastAssistant >= 0 && instance.messages[lastAssistant]!.role !== 'assistant') lastAssistant--;
      const unfinished = instance.messages[lastAssistant]?.tool_calls ?? [];
      const answered = new Set(instance.messages.slice(lastAssistant + 1).filter((message) => message.role === 'tool').map((message) => message.tool_use_id));
      for (const call of unfinished) {
        if (!answered.has(call.id)) instance.messages.push({ role: 'tool', tool_use_id: call.id, content: 'Tool execution interrupted. Check the workspace state before retrying.' });
      }
      if (controller.signal.aborted && instance.activeTurnId === turnId && (instance.status as string) !== 'cancelled') {
        instance.activeTurnId = undefined;
        instance.status = instance.mailbox.some((message) => message.status === 'pending') ? 'queued' : 'idle';
        instance.updatedAt = now();
      }
      this.emit({ type: 'instance_updated', instance: cloneInstance(instance) });
      await this.persistSession(instance.sessionId);
    }
  }

  private async executeAgentTool(instance: AgentInstance, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    try {
      if (name === 'spawn_agent') {
        return await this.spawnAgent(instance.instanceId, String(args.agent ?? ''), String(args.message ?? ''));
      }
      if (name === 'send_agent') {
        await this.sendAgent(instance.instanceId, String(args.instance_id ?? ''), String(args.message ?? ''));
        return 'Message delivered.';
      }
      if (name === 'wait_agent') {
        return await this.waitForAgents(instance.instanceId, parseStringList(args.instance_ids), Number(args.timeout_ms ?? 60_000));
      }
      if (name === 'cancel_agent') {
        await this.cancelAgent(instance.instanceId, String(args.instance_id ?? ''));
        return 'Agent cancelled.';
      }
      if (name === 'compact_context') {
        return await this.handleCompactContextTool(instance, args);
      }
      if (name === 'search_history') {
        const targetId = typeof args.instance_id === 'string' && args.instance_id.trim() ? args.instance_id.trim() : instance.instanceId;
        if (!this.isSelfOrDescendant(instance.instanceId, targetId)) return `Error: agent instance ${targetId} is not you or one of your descendants.`;
        return await this.searchArchivedContext(targetId, String(args.query ?? ''), Number(args.limit ?? 8) || 8);
      }
      const spec = this.registry.get(instance.agentId)!;
      if (!spec.tools.includes('*') && !spec.tools.includes(name)) return `Error: tool ${name} is not allowed by agent spec ${spec.id}`;
      return executeTool(name, args, {
        workspaceRoot: this.workspaceRoot,
        taskId: instance.instanceId,
        signal,
        policy: getToolPolicy(),
        acquireWriteLock: (path) => this.fileLocks.acquire(path),
        requirePriorRead: true,
        getReadVersion: (path) => this.readVersions.get(instance.instanceId)?.get(resolve(path)),
        recordReadVersion: (path, version) => {
          let versions = this.readVersions.get(instance.instanceId);
          if (!versions) {
            versions = new Map();
            this.readVersions.set(instance.instanceId, versions);
          }
          versions.set(resolve(path), version);
        },
        recordWriteVersion: (path, _version) => {
          this.readVersions.get(instance.instanceId)?.delete(resolve(path));
        },
      });
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async handleCompactContextTool(instance: AgentInstance, args: Record<string, unknown>): Promise<string> {
    const requestedId = typeof args.instance_id === 'string' && args.instance_id.trim() ? args.instance_id.trim() : instance.instanceId;
    if (!this.isSelfOrDescendant(instance.instanceId, requestedId)) {
      return `Error: agent instance ${requestedId} is not you or one of your descendants.`;
    }
    const focus = typeof args.focus === 'string' ? args.focus : undefined;
    const keepRecent = Number.isFinite(Number(args.keep_recent)) ? Number(args.keep_recent) : undefined;
    if (requestedId === instance.instanceId) {
      // Compacting your own context mid-turn would tear the current tool-call
      // batch apart; apply it at the next safe boundary (end of this batch).
      instance.pendingCompact = { focus, keepRecent, reason: 'manual' };
      return 'Compaction scheduled. Your older messages will be summarized and archived right after this tool batch completes; the digest stays in context and search_history can recall archived details.';
    }
    const target = this.instances.get(requestedId)!;
    if (target.status === 'running' || target.status === 'waiting') {
      return `Error: agent instance ${requestedId} is still running. Compact it after it becomes idle (wait_agent can help).`;
    }
    const result = await this.compactInstanceMessages(target, this.resolveConfigFor(target), { focus, keepRecent, reason: 'manual' });
    return result.detail;
  }

  private async persistSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const snapshot: PersistedAgentSession = {
      version: 1,
      session: cloneSession(session),
      instances: session.instanceIds.map((id) => this.instances.get(id)).filter((item): item is AgentInstance => Boolean(item)).map(cloneInstance),
    };
    await this.store.save(snapshot);
  }

  private notifyIdleWaiters(): void {
    for (const waiter of [...this.idleWaiters]) waiter();
  }
}
