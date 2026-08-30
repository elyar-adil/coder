import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { chatStream, type BackendConfig, type ChatChunk } from '../backend.js';
import type {
  AgentEvent,
  AgentInstance,
  AgentMailboxMessage,
  AgentModelMessage,
  AgentSession,
  AgentSpec,
  PersistedAgentSession,
  SessionMessage,
} from '../domain/agent.js';
import { executeTool, getToolPolicy, toolRegistry } from '../infra/tools.js';
import type { ToolDefinition } from '../tools/types.js';
import { AgentRegistry, matchesAgentSelector } from './agent-registry.js';
import { AgentRuntimeStore } from './agent-store.js';
import { FileLockManager } from './locks.js';

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
}

function now(): string {
  return new Date().toISOString();
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
  return { ...session, messages: session.messages.map((message) => ({ ...message })), instanceIds: [...session.instanceIds] };
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

export class AgentRuntime {
  readonly registry: AgentRegistry;
  private readonly store: AgentRuntimeStore;
  private readonly workspaceRoot: string;
  private readonly resolveModel: (alias?: string) => BackendConfig;
  private readonly modelStream: ModelStream;
  private readonly maxConcurrentTurns: number;
  private readonly maxAgentDepth: number;
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
    this.ready = Promise.all([this.registry.load(), this.store.init()]).then(() => this.validateSpecs());
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private emit(event: AgentEvent): void {
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
    const session = this.sessions.get(sessionId)!;
    session.messages = [];
    session.updatedAt = now();
    const main = this.instances.get(session.mainInstanceId);
    if (main) {
      this.controllers.get(main.instanceId)?.abort('Conversation cleared');
      main.messages = [];
      main.mailbox = [];
      main.status = 'idle';
      main.updatedAt = now();
    }
    await this.persistSession(sessionId);
  }

  async submitMessage(sessionId: string, content: string): Promise<string> {
    const text = content.trim();
    if (!text) throw new Error('Message cannot be empty');
    await this.openSession(sessionId);
    const session = this.sessions.get(sessionId)!;
    const main = this.instances.get(session.mainInstanceId)!;
    const turnId = randomUUID();
    const message: SessionMessage = { messageId: randomUUID(), role: 'user', content: text, createdAt: now(), turnId };
    session.messages.push(message);
    session.updatedAt = message.createdAt;
    if (main.status === 'running' || main.status === 'waiting') {
      this.controllers.get(main.instanceId)?.abort('Superseded by a newer user message');
    }
    this.deliver(main, text, undefined);
    await this.persistSession(sessionId);
    this.emit({ type: 'user_message', sessionId, message: { ...message } });
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
    const session = this.sessions.get(parent.sessionId)!;
    const child = this.newInstance(parent.sessionId, agentId, parent.instanceId, parent.depth + 1);
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
    if (!done()) {
      requester.status = 'waiting';
      this.emit({ type: 'instance_updated', instance: cloneInstance(requester) });
      // Waiting on mailboxes consumes no model/tool capacity. Yield this slot
      // so all requested siblings can run even when their count reaches the
      // global concurrency limit.
      const yieldedCapacity = this.running.delete(requester.instanceId);
      if (yieldedCapacity) this.pump();
      await new Promise<void>((resolveWait) => {
        const timeout = setTimeout(() => { this.idleWaiters.delete(check); resolveWait(); }, Math.min(Math.max(timeoutMs, 100), 300_000));
        const check = (): void => {
          if (!done()) return;
          clearTimeout(timeout);
          this.idleWaiters.delete(check);
          resolveWait();
        };
        this.idleWaiters.add(check);
      });
      if (yieldedCapacity) {
        while (this.running.size >= this.maxConcurrentTurns) {
          await new Promise<void>((resolveCapacity) => {
            const check = (): void => {
              if (this.running.size >= this.maxConcurrentTurns) return;
              this.idleWaiters.delete(check);
              resolveCapacity();
            };
            this.idleWaiters.add(check);
          });
        }
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

  private deliver(target: AgentInstance, content: string, fromInstanceId?: string): void {
    const message: AgentMailboxMessage = { messageId: randomUUID(), fromInstanceId, content, createdAt: now(), status: 'pending' };
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

  private pump(): void {
    while (!this.shuttingDown && this.running.size < this.maxConcurrentTurns && this.queue.length) {
      const id = this.queue.shift()!;
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
    const relatedInstances = this.listInstances(instance.sessionId)
      .filter((candidate) => candidate.instanceId !== instance.instanceId && candidate.status !== 'cancelled')
      .map((candidate) => `- ${candidate.agentId} (${candidate.instanceId}): ${candidate.status}${candidate.lastOutput ? ` — ${candidate.lastOutput.slice(0, 180)}` : ''}`);
    return [
      spec.instructions,
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
      relatedInstances.length
        ? `Existing instances in this session:\n${relatedInstances.join('\n')}`
        : 'Existing instances in this session: none.',
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
    return tools;
  }

  private trimMessages(messages: AgentModelMessage[], config: BackendConfig): AgentModelMessage[] {
    const budgetChars = Math.max(16_000, Math.floor((config.contextWindow ?? 131_072) * 4 * 0.72));
    let total = 0;
    const kept: AgentModelMessage[] = [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      const size = String(message.content ?? '').length + JSON.stringify(message.tool_calls ?? []).length;
      if (kept.length && total + size > budgetChars) break;
      kept.unshift(message);
      total += size;
    }
    return kept;
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
    const turnId = randomUUID();
    instance.activeTurnId = turnId;
    instance.status = 'running';
    instance.updatedAt = now();
    this.controllers.set(instance.instanceId, controller);
    this.absorbMailbox(instance);
    this.emit({ type: 'instance_updated', instance: cloneInstance(instance) });
    await this.persistSession(instance.sessionId);

    try {
      const config = this.resolveModel(spec.model ?? session.defaultModel ?? this.defaultModel);
      if (!config.model) throw new Error('No model configured. Use /provider or /model first.');
      const tools = this.toolsFor(instance, spec);
      let finalOutput = '';
      for (let step = 0; step < 32; step += 1) {
        if (controller.signal.aborted || instance.activeTurnId !== turnId) return;
        const messages = this.trimMessages(instance.messages, config);
        let text = '';
        const calls: NonNullable<AgentModelMessage['tool_calls']> = [];
        for await (const chunk of this.modelStream(config, this.systemPrompt(instance, spec), messages, tools, controller.signal)) {
          if (controller.signal.aborted || instance.activeTurnId !== turnId) return;
          if (chunk.content) {
            text += chunk.content;
            finalOutput += chunk.content;
            if (!instance.parentInstanceId) {
              this.emit({ type: 'assistant_delta', sessionId: session.sessionId, instanceId: instance.instanceId, turnId, text: chunk.content });
            }
          }
          if (chunk.toolCalls?.length) calls.push(...chunk.toolCalls);
        }
        instance.messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
        if (text.trim() && !instance.parentInstanceId) {
          const visible: SessionMessage = { messageId: randomUUID(), role: 'assistant', content: text.trim(), createdAt: now(), turnId };
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
        }
      }
      if (controller.signal.aborted || instance.activeTurnId !== turnId) return;
      instance.lastOutput = finalOutput.trim() || instance.lastOutput;
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
      const spec = this.registry.get(instance.agentId)!;
      if (!spec.tools.includes('*') && !spec.tools.includes(name)) return `Error: tool ${name} is not allowed by agent spec ${spec.id}`;
      return executeTool(name, args, {
        workspaceRoot: this.workspaceRoot,
        taskId: instance.instanceId,
        signal,
        policy: getToolPolicy(),
        acquireWriteLock: (path) => this.fileLocks.acquire(path),
      });
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
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
