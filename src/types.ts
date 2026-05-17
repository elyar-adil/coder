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
  completedAt?: string;
}

export interface PromptTask {
  taskId: string;
  userId: string;
  prompt: string;
  mode: TaskMode;
  status: TaskStatus;
  result?: string;
  plan: PlanStep[];
  phaseEvents: PhaseEvent[];
}
