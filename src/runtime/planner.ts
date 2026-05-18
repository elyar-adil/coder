import type { OllamaMsg, PlanStep, PlannerDecision, SharedContextSnapshot } from '../domain/task.js';

export interface OllamaStreamChunk {
  message?: OllamaMsg & { content: string | null };
  done?: boolean;
}

export function parsePlan(content: string): PlanStep[] {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  const jsonText = start >= 0 && end >= start ? candidate.slice(start, end + 1) : candidate;
  const parsed = JSON.parse(jsonText) as Array<{ title?: string; detail?: string }>;
  if (!Array.isArray(parsed)) throw new Error('Plan mode expects JSON array');
  return parsed.map((step) => ({
    title: typeof step.title === 'string' && step.title.trim() ? step.title.slice(0, 120) : 'step',
    detail: typeof step.detail === 'string' ? step.detail.slice(0, 1200) : '',
  }));
}

export function parseOllamaNdjson(line: string): OllamaStreamChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as OllamaStreamChunk;
  } catch {
    return null;
  }
}

export function fallbackPlannerDecision(prompt: string): PlannerDecision {
  const lower = prompt.toLowerCase();
  const readOnly = /\b(explain|what|why|how|read|inspect|analy[sz]e|understand|look at)\b/.test(lower)
    && !/\b(add|fix|write|edit|update|implement|refactor|create|delete)\b/.test(lower);

  return {
    summary: prompt.slice(0, 160),
    mode: readOnly ? 'analyze' : 'code',
    readOnly,
    subtasks: [
      { title: readOnly ? 'Inspect relevant code' : 'Implement requested change', detail: prompt.slice(0, 240) },
    ],
    questions: [],
  };
}

export function parsePlannerDecision(content: string, prompt: string): PlannerDecision {
  try {
    const trimmed = content.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced?.[1] ?? trimmed).trim();
    const parsed = JSON.parse(candidate) as Partial<PlannerDecision>;
    const subtasks = Array.isArray(parsed.subtasks)
      ? parsed.subtasks
          .map((step) => ({
            title: typeof step?.title === 'string' && step.title.trim() ? step.title.slice(0, 120) : 'step',
            detail: typeof step?.detail === 'string' ? step.detail.slice(0, 800) : '',
          }))
      : [];

    const questions = Array.isArray(parsed.questions)
      ? parsed.questions.filter((question): question is string => typeof question === 'string').map((question) => question.slice(0, 200))
      : [];

    const mode = parsed.mode === 'analyze' || parsed.mode === 'code' || parsed.mode === 'mixed'
      ? parsed.mode
      : 'code';

    return {
      summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.slice(0, 240) : prompt.slice(0, 160),
      mode,
      readOnly: Boolean(parsed.readOnly),
      subtasks: subtasks.length > 0 ? subtasks : fallbackPlannerDecision(prompt).subtasks,
      questions,
    };
  } catch {
    return fallbackPlannerDecision(prompt);
  }
}

export function renderSharedContext(snapshot: SharedContextSnapshot): string {
  const active = snapshot.activeTasks.length > 0
    ? snapshot.activeTasks.map((task) => `- ${task.taskId.slice(0, 8)} [${task.status}] ${task.prompt.slice(0, 80)}`).join('\n')
    : '- none';

  const recent = snapshot.recentTasks.length > 0
    ? snapshot.recentTasks.map((task) => `- ${task.taskId.slice(0, 8)} [${task.status}] ${task.prompt.slice(0, 80)}`).join('\n')
    : '- none';

  return [
    'Shared workspace context:',
    snapshot.summary || 'No shared summary yet.',
    '',
    'Active tasks:',
    active,
    '',
    'Recent tasks:',
    recent,
  ].join('\n');
}
