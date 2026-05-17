import { randomUUID } from 'node:crypto';
import type { PhaseEvent, PlanStep, PromptTask, TaskMode, TaskPhase } from './types.js';

export class MasterCoordinator {
  private tasks = new Map<string, PromptTask>();

  constructor(
    private readonly ollamaBaseUrl: string,
    private readonly model: string = 'deepseek-v4-pro:cloud',
  ) {}

  async acceptPrompt(userId: string, prompt: string, mode: TaskMode = 'execute'): Promise<string> {
    const taskId = randomUUID();
    const task: PromptTask = { taskId, userId, prompt, mode, status: 'queued', plan: [], phaseEvents: [] };
    this.tasks.set(taskId, task);
    void this.runTask(taskId);
    return taskId;
  }

  getTask(taskId: string): PromptTask | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): PromptTask[] {
    return [...this.tasks.values()];
  }

  async executePlan(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.mode !== 'plan' || task.plan.length === 0) return false;
    task.mode = 'execute';
    task.prompt = `Execute this approved plan:\n${task.plan.map((s) => `- ${s.title}: ${s.detail}`).join('\n')}`;
    void this.runTask(taskId);
    return true;
  }

  private markPhase(task: PromptTask, phase: TaskPhase, status: PhaseEvent['status'], note?: string): void {
    task.phaseEvents.push({ phase, status, note, ts: new Date().toISOString() });
  }

  private async runTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = 'running';

    try {
      if (task.mode === 'plan') {
        this.markPhase(task, 'plan', 'in_progress', 'Generating execution plan');
        const content = await this.callModel(task.prompt, 'plan');
        task.plan = this.parsePlan(content);
        this.markPhase(task, 'plan', 'done', `Generated ${task.plan.length} steps`);
        task.result = 'plan_ready';
        task.status = 'blocked';
        return;
      }

      if (task.mode === 'react') {
        await this.runReactFlow(task);
        return;
      }

      // execute
      this.markPhase(task, 'write_code', 'in_progress', 'Direct execute mode');
      const content = await this.callModel(task.prompt, 'execute');
      task.result = content;
      this.markPhase(task, 'write_code', 'done');
      task.status = 'completed';
    } catch (err) {
      task.status = 'failed';
      task.result = `Agent failed: ${String(err)}`;
      this.markPhase(task, 'finalize', 'failed', task.result);
    }
  }

  private async runReactFlow(task: PromptTask): Promise<void> {
    this.markPhase(task, 'plan', 'in_progress', 'REACT: planning');
    const planContent = await this.callModel(`Create a concise coding plan for:\n${task.prompt}`, 'plan');
    task.plan = this.parsePlan(planContent);
    this.markPhase(task, 'plan', 'done', `Plan with ${task.plan.length} steps`);

    this.markPhase(task, 'inspect_code', 'in_progress', 'REACT: reading codebase strategy');
    const inspectResult = await this.callModel(
      `Given this plan ${JSON.stringify(task.plan)}, explain what files/components should be inspected first.`,
      'execute',
    );
    this.markPhase(task, 'inspect_code', 'done', inspectResult.slice(0, 120));

    this.markPhase(task, 'write_code', 'in_progress', 'REACT: synthesize implementation steps');
    const implementation = await this.callModel(
      `Based on plan ${JSON.stringify(task.plan)} and analysis ${inspectResult}, provide concrete code-change instructions.`,
      'execute',
    );
    this.markPhase(task, 'write_code', 'done');

    this.markPhase(task, 'verify', 'in_progress', 'REACT: verification checklist');
    const verify = await this.callModel(
      `Produce a verification checklist and commands for implementation:\n${implementation}`,
      'execute',
    );
    this.markPhase(task, 'verify', 'done');

    task.result = [
      '# REACT RESULT',
      '## Plan',
      ...task.plan.map((s, i) => `${i + 1}. ${s.title} - ${s.detail}`),
      '## Inspect Code',
      inspectResult,
      '## Write Code',
      implementation,
      '## Verify',
      verify,
    ].join('\n');

    this.markPhase(task, 'finalize', 'done', 'REACT flow completed');
    task.status = 'completed';
  }

  private async callModel(prompt: string, mode: 'plan' | 'execute'): Promise<string> {
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
