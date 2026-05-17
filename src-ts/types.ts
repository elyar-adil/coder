export type TaskStatus = 'queued' | 'running' | 'blocked' | 'completed' | 'failed';
export type TaskMode = 'execute' | 'plan';

export interface PlanStep {
  title: string;
  detail: string;
}

export interface PromptTask {
  taskId: string;
  userId: string;
  prompt: string;
  mode: TaskMode;
  status: TaskStatus;
  result?: string;
  plan: PlanStep[];
}
