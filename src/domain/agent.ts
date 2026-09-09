import type { ToolDefinition } from '../tools/types.js';

export type AgentSpecScope = 'builtin' | 'user' | 'project';

export interface AgentSpec {
  id: string;
  description: string;
  model?: string;
  tools: string[];
  agents: string[];
  instructions: string;
  source: string;
  scope: AgentSpecScope;
}

export interface AgentToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, string>;
  };
}

export interface AgentModelMessage {
  responseItems?: Record<string, unknown>[];
  role: string;
  content: string | null;
  tool_calls?: AgentToolCall[];
  tool_use_id?: string;
}

/** Provider reported usage for one model request. Values are optional because
 * local and OpenAI-compatible gateways do not always return usage in streams. */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface AgentUsage extends ModelUsage {
  requests: number;
  turns: number;
  firstTokenMs?: number;
  lastTurnMs?: number;
}

export type AgentInstanceStatus = 'queued' | 'running' | 'idle' | 'waiting' | 'failed' | 'cancelled';

export interface AgentMailboxMessage {
  turnId?: string;
  messageId: string;
  fromInstanceId?: string;
  content: string;
  createdAt: string;
  status: 'pending' | 'delivered';
}

export interface AgentInstance {
  instanceId: string;
  sessionId: string;
  agentId: string;
  parentInstanceId?: string;
  depth: number;
  status: AgentInstanceStatus;
  messages: AgentModelMessage[];
  mailbox: AgentMailboxMessage[];
  childInstanceIds: string[];
  createdAt: string;
  updatedAt: string;
  lastOutput?: string;
  lastError?: string;
  activeTurnId?: string;
  /** Number of times this instance's context has been compacted. */
  compactionCount?: number;
  /** Scheduled compaction, applied at the next safe boundary (end of the current tool batch). */
  pendingCompact?: { focus?: string; keepRecent?: number; reason: 'auto' | 'manual' };
  /** Turn that created children, used to prevent unbounded fan-out. */
  parentTurnId?: string;
  usage?: AgentUsage;
  lastTurn?: { startedAt: string; endedAt: string; durationMs: number; usage?: ModelUsage };
}

export interface SessionMessage {
  thinking?: string;
  messageId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  turnId?: string;
}

export interface AgentSession {
  timeline?: SessionTimelineEntry[];
  sessionId: string;
  mainInstanceId: string;
  defaultModel?: string;
  /** Standing directive injected into every agent prompt of this session until cleared (/goal). */
  goal?: string;
  /** Aside notes queued with /btw that fold into the next submitted message without starting a turn. */
  pendingAsides?: string[];
  messages: SessionMessage[];
  instanceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionTimelineEntry {
  id: string;
  kind: 'message' | 'thinking' | 'tool';
  instanceId?: string;
  turnId?: string;
  role?: 'user' | 'assistant' | 'system';
  content: string;
  tool?: string;
  input?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

export interface PersistedAgentSession {
  version: 1;
  session: AgentSession;
  instances: AgentInstance[];
}

export type AgentEvent =
  | { type: 'thinking_delta'; sessionId: string; instanceId: string; turnId: string; text: string }
  | { type: 'session_opened'; session: AgentSession }
  | { type: 'user_message'; sessionId: string; message: SessionMessage }
  | { type: 'assistant_delta'; sessionId: string; instanceId: string; turnId: string; text: string }
  | { type: 'assistant_message'; sessionId: string; instanceId: string; message: SessionMessage }
  | { type: 'system_message'; sessionId: string; message: SessionMessage }
  | { type: 'instance_created'; instance: AgentInstance }
  | { type: 'instance_updated'; instance: AgentInstance }
  | { type: 'mailbox_message'; instanceId: string; message: AgentMailboxMessage }
  | { type: 'tool_started'; instanceId: string; turnId: string; tool: string; input: string }
  | { type: 'tool_finished'; instanceId: string; turnId: string; tool: string; output: string }
  | { type: 'context_compacted'; sessionId: string; instanceId: string; agentId: string; reason: 'auto' | 'manual'; archivedMessages: number; charsBefore: number; charsAfter: number }
  | { type: 'runtime_error'; sessionId?: string; instanceId?: string; error: string };

export interface RuntimeTool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<string>;
}
