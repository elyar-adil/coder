import type { ToolPolicy } from '../policy.js';

export type TaskStatus = 'queued' | 'running' | 'blocked' | 'waiting_user' | 'completed' | 'failed';
export type TaskMode = 'build' | 'plan';
export type TaskModeInput = TaskMode | 'execute' | 'react';
export type TaskKind = 'worker' | 'inquiry' | 'derived_worker' | 'sync_worker' | 'clarification';
export type AgentRole = 'master' | 'worker' | 'subagent' | 'writer' | 'presentation';
export type TaskPhase = 'plan' | 'execute' | 'design' | 'inspect_code' | 'write_code' | 'verify' | 'finalize';
export type PlanStepIntent = 'answer' | 'tool_loop' | 'code_change' | 'verify' | 'ask_user';
export type PlanStepToolPolicy = 'none' | 'safe' | 'read_only' | 'code_write' | 'verify';

export interface PlanStep {
  title: string;
  detail: string;
  intent?: PlanStepIntent;
  toolPolicy?: PlanStepToolPolicy;
  instruction?: string;
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

export interface TaskMailboxMessage {
  messageId: string;
  text: string;
  sourceTaskId?: string;
  createdAt: string;
  absorbedAt?: string;
  status: 'pending' | 'absorbed';
}

export interface TaskContextSnapshot {
  taskId: string;
  kind?: TaskKind;
  prompt: string;
  summary?: string;
  mode: TaskMode;
  status: TaskStatus;
  phase?: string;
  recentOutput?: string;
  result?: string;
  pendingUpdates: string[];
  updatedAt?: string;
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
  steps: PlanStep[];
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

export interface PatchFileChange {
  path: string;
  baseHash?: string;
  before?: string;
  after: string;
  diff?: string;
}

export interface PatchSet {
  patchId: string;
  taskId: string;
  summary: string;
  files: PatchFileChange[];
  verificationCommands: string[];
  status: 'submitted' | 'applied' | 'verified' | 'conflict' | 'failed';
  createdAt: string;
  updatedAt: string;
  result?: string;
  conflicts?: Array<{ path: string; expectedHash?: string; actualHash: string }>;
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

export interface LlmTraceEntry {
  ts: string;
  label: string;
  systemPrompt: string;
  messages: OllamaMsg[];
  response: string;
  toolCalls?: OllamaMsg['tool_calls'];
  cached?: boolean;
}

export interface Goal {
  description: string;
  completionCriteria: string;
  status: 'in_progress' | 'achieved' | 'failed';
}

export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface PromptTask {
  traceId?: string;
  taskId: string;
  sessionId?: string;
  agentRole?: AgentRole;
  userId: string;
  prompt: string;
  kind?: TaskKind;
  mode: TaskMode;
  status: TaskStatus;
  result?: string;
  plan: PlanStep[];
  phaseEvents: PhaseEvent[];
  messages?: OllamaMsg[];
  llmTrace?: LlmTraceEntry[];
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
  relatedTaskIds?: string[];
  mailbox?: TaskMailboxMessage[];
  contextSnapshot?: string;
  artifactDir?: string;
  visibleMessages?: Array<{ messageId: string; text: string; ts: string }>;
  debugEvents?: Array<{ type: string; text: string; ts: string }>;
  patchSets?: PatchSet[];
  goal?: Goal;
  todos?: TodoItem[];
  goalIteration?: number;
}

export type ReleaseLock = () => void | Promise<void>;

export interface ToolContext {
  spawnSubagent: (prompt: string) => Promise<string>;
  collectSubagent: (id: string) => Promise<string>;
  requestClarification?: (question: string, choices?: string[]) => Promise<string>;
  submitPatch?: (patch: Omit<PatchSet, 'patchId' | 'taskId' | 'status' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  acquireWriteLock?: (path: string) => Promise<ReleaseLock>;
  policy?: ToolPolicy;
  sharedContext?: string;
  artifactDir?: string;
  taskId?: string;
}

export type MasterEvent =
  | { type: 'task_created'; task: PromptTask; ts: string }
  | { type: 'task_updated'; task: PromptTask; ts: string }
  | { type: 'master_response'; text: string; relatedTaskIds?: string[]; ts: string }
  | { type: 'user_visible_message'; taskId?: string; sessionId?: string; role: 'assistant' | 'system'; text: string; ts: string }
  | { type: 'task_mailbox_updated'; taskId: string; message: TaskMailboxMessage; ts: string }
  | { type: 'subagent_created'; subagent: SubAgentTask; ts: string }
  | { type: 'subagent_updated'; subagent: SubAgentTask; ts: string }
  | { type: 'subagent_output'; subagentId: string; parentTaskId: string; text: string; ts: string }
  | { type: 'writer_patch_submitted'; taskId: string; patch: PatchSet; ts: string }
  | { type: 'writer_patch_applied'; taskId: string; patch: PatchSet; ts: string }
  | { type: 'writer_patch_verified'; taskId: string; patch: PatchSet; ts: string }
  | { type: 'writer_conflict'; taskId: string; patch: PatchSet; conflicts: NonNullable<PatchSet['conflicts']>; ts: string }
  | { type: 'writer_failed'; taskId: string; patch: PatchSet; error: string; ts: string }
  | { type: 'task_phase'; taskId: string; phase: TaskPhase; status: PhaseEvent['status']; note?: string; ts: string }
  | { type: 'task_output'; taskId: string; text: string; ts: string }
  | { type: 'tool_call'; taskId: string; tool: string; input: string; ts: string }
  | { type: 'tool_result'; taskId: string; tool: string; output: string; ts: string }
  | { type: 'clarification_requested'; taskId: string; clarification: ClarificationRequest; ts: string }
  | { type: 'clarification_answered'; taskId: string; clarificationId: string; answer: string; ts: string }
  | { type: 'todo_updated'; taskId: string; todos: TodoItem[]; ts: string }
  | { type: 'goal_status_changed'; taskId: string; goal: Goal; ts: string }
  | { type: 'task_done'; taskId: string; result: string; status: 'completed' | 'failed'; ts: string };

export interface TelemetryEvent {
  traceId: string;
  ts: string;
  type: 'phase_started' | 'phase_done' | 'tool_call' | 'tool_result' | 'backend_retry' | 'error';
  taskId: string;
  note?: string;
  latencyMs?: number;
}

export function isTaskModeInput(value: unknown): value is TaskModeInput {
  return value === 'build' || value === 'plan' || value === 'execute' || value === 'react';
}

export function normalizeTaskMode(value: TaskModeInput | string | undefined): TaskMode {
  if (value === 'plan') return 'plan';
  return 'build';
}
