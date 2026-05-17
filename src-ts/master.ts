import { randomUUID } from 'node:crypto';
import type { PlanStep, PromptTask, TaskMode } from './types.js';

export class MasterCoordinator {
  private tasks = new Map<string, PromptTask>();

  constructor(
    private readonly ollamaBaseUrl: string,
    private readonly model: string = 'deepseek-v4-pro:cloud',
  ) {}

  async acceptPrompt(userId: string, prompt: string, mode: TaskMode = 'execute'): Promise<string> {
    const taskId = randomUUID();
    const task: PromptTask = { taskId, userId, prompt, mode, status: 'queued', plan: [] };
    this.tasks.set(taskId, task);
    void this.runTask(taskId);
    return taskId;
  }

  getTask(taskId: string): PromptTask | undefined {
    return this.tasks.get(taskId);
  }

  async executePlan(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.mode !== 'plan' || task.plan.length === 0) return false;
    task.mode = 'execute';
    task.prompt = `Execute this approved plan:\n${task.plan.map((s) => `- ${s.title}: ${s.detail}`).join('\n')}`;
    void this.runTask(taskId);
    return true;
  }

  private async runTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = 'running';
    try {
      const content = await this.callModel(task.prompt, task.mode);
      if (task.mode === 'plan') {
        task.plan = this.parsePlan(content);
        task.result = 'plan_ready';
        task.status = 'blocked';
      } else {
        task.result = content;
        task.status = 'completed';
      }
    } catch (err) {
      task.status = 'failed';
      task.result = `Agent failed: ${String(err)}`;
    }
  }

  private async callModel(prompt: string, mode: TaskMode): Promise<string> {
    const system = mode === 'plan'
      ? 'Return ONLY a JSON array of plan steps: [{"title":"...","detail":"..."}]'
      : 'You are a senior coding agent. Complete the user request safely and accurately.';

    const response = await fetch(`${this.ollamaBaseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { message?: { content?: string } };
    const content = data.message?.content?.trim();
    if (!content) throw new Error('Missing message.content');
    return content;
  }

  private parsePlan(content: string): PlanStep[] {
    const parsed = JSON.parse(content) as Array<{ title?: string; detail?: string }>;
    if (!Array.isArray(parsed)) throw new Error('Plan mode expects JSON array');
    return parsed.map((s) => ({ title: s.title ?? 'step', detail: s.detail ?? '' }));
  }
}
