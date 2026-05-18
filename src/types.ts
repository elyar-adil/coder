export type TaskStatus = 'queued' | 'running' | 'blocked' | 'completed' | 'failed';
export type TaskMode = 'execute' | 'plan' | 'react';
export type TaskPhase = 'plan' | 'design' | 'inspect_code' | 'write_code' | 'verify' | 'finalize';

export interface PlanStep {
  title: string;
  detail: string;
}

export interface PhaseEvent {
  phase: TaskPhase;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  note?: string;
  ts: string;
}

export interface SubAgentTask {
  taskId: string;
  parentTaskId: string;
  prompt: string;
  status: TaskStatus;
  result?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  timeoutMs?: number;
  cancelled?: boolean;
  errorType?: 'timeout' | 'tool_error' | 'model_error' | 'cancelled';
}

export interface OllamaMsg {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, string> };
  }>;
}

export interface PromptTask {
  traceId?: string;
  taskId: string;
  userId: string;
  prompt: string;
  mode: TaskMode;
  status: TaskStatus;
  result?: string;
  plan: PlanStep[];
  phaseEvents: PhaseEvent[];
  messages?: OllamaMsg[];
  designDoc?: string;
}

export interface ToolContext {
  spawnSubagent: (p: string) => Promise<string>;
  collectSubagent: (id: string) => Promise<string>;
  askUser?: (question: string) => Promise<string>;
}

export interface TelemetryEvent {
  traceId: string;
  ts: string;
  type: 'phase_started' | 'phase_done' | 'tool_call' | 'tool_result' | 'backend_retry' | 'error';
  taskId: string;
  note?: string;
  latencyMs?: number;
}
