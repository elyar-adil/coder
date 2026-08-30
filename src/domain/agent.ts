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
  role: string;
  content: string | null;
  tool_calls?: AgentToolCall[];
  tool_use_id?: string;
}

export type AgentInstanceStatus = 'queued' | 'running' | 'idle' | 'waiting' | 'failed' | 'cancelled';

export interface AgentMailboxMessage {
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
}

export interface SessionMessage {
  messageId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  turnId?: string;
}

export interface AgentSession {
  sessionId: string;
  mainInstanceId: string;
  defaultModel?: string;
  messages: SessionMessage[];
  instanceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PersistedAgentSession {
  version: 1;
  session: AgentSession;
  instances: AgentInstance[];
}

export type AgentEvent =
  | { type: 'session_opened'; session: AgentSession }
  | { type: 'user_message'; sessionId: string; message: SessionMessage }
  | { type: 'assistant_delta'; sessionId: string; instanceId: string; turnId: string; text: string }
  | { type: 'assistant_message'; sessionId: string; instanceId: string; message: SessionMessage }
  | { type: 'instance_created'; instance: AgentInstance }
  | { type: 'instance_updated'; instance: AgentInstance }
  | { type: 'mailbox_message'; instanceId: string; message: AgentMailboxMessage }
  | { type: 'tool_started'; instanceId: string; turnId: string; tool: string; input: string }
  | { type: 'tool_finished'; instanceId: string; turnId: string; tool: string; output: string }
  | { type: 'runtime_error'; sessionId?: string; instanceId?: string; error: string };

export interface RuntimeTool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

