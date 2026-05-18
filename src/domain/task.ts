import type { ToolPolicy } from '../policy.js';

export type TaskStatus = 'queued' | 'running' | 'blocked' | 'waiting_user' | 'completed' | 'failed';
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

export interface ClarificationRequest {
  clarificationId: string;
  taskId: string;
  question: string;
  choices: string[];
  createdAt: string;
  status: 'pending' | 'answered';
  answer?: string;
}

export interface TaskSummary {
  taskId: string;
  prompt: string;
  mode: TaskMode;
  status: TaskStatus;
  result?: string;
  updatedAt?: string;
}

export interface SharedContextSnapshot {
  summary: string;
  activeTasks: TaskSummary[];
  recentTasks: TaskSummary[];
}

export interface PlannerDecision {
  summary: string;
  mode: 'analyze' | 'code' | 'mixed';
  readOnly: boolean;
  subtasks: PlanStep[];
  questions: string[];
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
  readOnly?: boolean;
}

export interface OllamaMsg {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id?: string;
    function: { name: string; arguments: Record<string, string> };
  }>;
  tool_use_id?: string;
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
  summary?: string;
  sharedContext?: string;
  readOnly?: boolean;
  planner?: PlannerDecision;
  pendingClarifications?: ClarificationRequest[];
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  parentTaskId?: string;
}

export type ReleaseLock = () => void | Promise<void>;

export interface ToolContext {
  spawnSubagent: (prompt: string) => Promise<string>;
  collectSubagent: (id: string) => Promise<string>;
  requestClarification?: (question: string, choices?: string[]) => Promise<string>;
  acquireWriteLock?: (path: string) => Promise<ReleaseLock>;
  policy?: ToolPolicy;
  sharedContext?: string;
  taskId?: string;
}

export type MasterEvent =
  | { type: 'task_created'; task: PromptTask; ts: string }
  | { type: 'task_updated'; task: PromptTask; ts: string }
  | { type: 'subagent_created'; subagent: SubAgentTask; ts: string }
  | { type: 'subagent_updated'; subagent: SubAgentTask; ts: string }
  | { type: 'subagent_output'; subagentId: string; parentTaskId: string; text: string; ts: string }
  | { type: 'task_phase'; taskId: string; phase: TaskPhase; status: PhaseEvent['status']; note?: string; ts: string }
  | { type: 'task_output'; taskId: string; text: string; ts: string }
  | { type: 'tool_call'; taskId: string; tool: string; input: string; ts: string }
  | { type: 'tool_result'; taskId: string; tool: string; output: string; ts: string }
  | { type: 'clarification_requested'; taskId: string; clarification: ClarificationRequest; ts: string }
  | { type: 'clarification_answered'; taskId: string; clarificationId: string; answer: string; ts: string }
  | { type: 'task_done'; taskId: string; result: string; status: 'completed' | 'failed'; ts: string };

export interface TelemetryEvent {
  traceId: string;
  ts: string;
  type: 'phase_started' | 'phase_done' | 'tool_call' | 'tool_result' | 'backend_retry' | 'error';
  taskId: string;
  note?: string;
  latencyMs?: number;
}
