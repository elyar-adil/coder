import type { OllamaMsg, PlanStep, PlanStepIntent, PlanStepToolPolicy, PlannerDecision, SharedContextSnapshot, TodoItem } from '../domain/task.js';

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
  const parsed = JSON.parse(jsonText) as Array<Partial<PlanStep>>;
  if (!Array.isArray(parsed)) throw new Error('Plan mode expects JSON array');
  return parsed.map((step) => ({
    title: typeof step.title === 'string' && step.title.trim() ? step.title.slice(0, 120) : 'step',
    detail: typeof step.detail === 'string' ? step.detail.slice(0, 1200) : '',
    intent: isStepIntent(step.intent) ? step.intent : undefined,
    toolPolicy: isToolPolicy(step.toolPolicy) ? step.toolPolicy : undefined,
    instruction: typeof step.instruction === 'string' ? step.instruction.slice(0, 2000) : undefined,
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
  const arithmetic = isArithmeticPrompt(prompt);
  const readOnly = /\b(explain|what|why|how|read|inspect|analy[sz]e|understand|look at)\b/.test(lower)
    && !/\b(add|fix|write|edit|update|implement|refactor|create|delete)\b/.test(lower);
  const steps: PlanStep[] = arithmetic
    ? [{
        title: 'Calculate exact answer',
        detail: 'Use bash to calculate the arithmetic expression and answer concisely.',
        intent: 'tool_loop',
        toolPolicy: 'safe',
        instruction: `Use bash to calculate this exactly, then answer only with the result and a brief equation: ${prompt}`,
      }]
    : [{
        title: readOnly ? 'Answer request' : 'Handle request',
        detail: prompt.slice(0, 240),
        intent: readOnly ? 'answer' : 'code_change',
        toolPolicy: readOnly ? 'none' : 'code_write',
        instruction: prompt.slice(0, 600),
      }];

  return {
    summary: prompt.slice(0, 160),
    mode: arithmetic || readOnly ? 'analyze' : 'code',
    readOnly: arithmetic || readOnly,
    subtasks: steps,
    steps,
    questions: [],
  };
}

export interface ParsedPlannerDecision extends PlannerDecision {
  todos?: TodoItem[];
}

export function parsePlannerDecision(content: string, prompt: string): ParsedPlannerDecision {
  try {
    const trimmed = content.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced?.[1] ?? trimmed).trim();
    const parsed = JSON.parse(candidate) as Partial<ParsedPlannerDecision>;
    const rawSteps = Array.isArray(parsed.steps)
      ? parsed.steps
      : Array.isArray(parsed.subtasks)
        ? parsed.subtasks
        : [];
    let steps = rawSteps.map(normalizeStep).filter((step) => step.title || step.detail);

    const questions = Array.isArray(parsed.questions)
      ? parsed.questions.filter((question): question is string => typeof question === 'string').map((question) => question.slice(0, 200))
      : [];

    const mode = parsed.mode === 'analyze' || parsed.mode === 'code' || parsed.mode === 'mixed'
      ? parsed.mode
      : 'code';

    if (steps.length === 0) steps = fallbackPlannerDecision(prompt).steps;
    if (isArithmeticPrompt(prompt) && !steps.some((step) => step.intent === 'tool_loop')) {
      steps = fallbackPlannerDecision(prompt).steps;
    }

    const todos: TodoItem[] | undefined = Array.isArray(parsed.todos)
      ? (parsed.todos as unknown[])
          .filter((t): t is Record<string, unknown> => t != null && typeof t === 'object')
          .map((t) => ({
            id: String(t['id'] ?? ''),
            text: String(t['text'] ?? ''),
            status: (['done', 'in_progress', 'pending'].includes(String(t['status'])) ? t['status'] : 'pending') as TodoItem['status'],
          }))
      : undefined;

    return {
      summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.slice(0, 240) : prompt.slice(0, 160),
      mode,
      readOnly: Boolean(parsed.readOnly) || steps.every((step) => step.intent !== 'code_change' && step.intent !== 'verify'),
      subtasks: steps,
      steps,
      questions,
      todos,
    };
  } catch {
    return fallbackPlannerDecision(prompt);
  }
}

function isStepIntent(value: unknown): value is PlanStepIntent {
  return value === 'answer' || value === 'tool_loop' || value === 'code_change' || value === 'verify' || value === 'ask_user';
}

function isToolPolicy(value: unknown): value is PlanStepToolPolicy {
  return value === 'none' || value === 'safe' || value === 'read_only' || value === 'code_write' || value === 'verify';
}

function normalizeStep(step: Partial<PlanStep> | undefined): PlanStep {
  const intent = isStepIntent(step?.intent) ? step.intent : inferIntent(step);
  const toolPolicy = isToolPolicy(step?.toolPolicy) ? step.toolPolicy : defaultToolPolicyForIntent(intent);
  const detail = typeof step?.detail === 'string' ? step.detail.slice(0, 1200) : '';
  const instruction = typeof step?.instruction === 'string' ? step.instruction.slice(0, 2000) : detail;
  return {
    title: typeof step?.title === 'string' && step.title.trim() ? step.title.slice(0, 120) : 'step',
    detail,
    intent,
    toolPolicy,
    instruction,
  };
}

function inferIntent(step: Partial<PlanStep> | undefined): PlanStepIntent {
  const text = `${step?.title ?? ''} ${step?.detail ?? ''}`.toLowerCase();
  if (/\b(ask|clarif|question|confirm)\b/.test(text)) return 'ask_user';
  if (/\b(test|verify|typecheck|build|lint)\b/.test(text)) return 'verify';
  if (/\b(edit|write|modify|implement|fix|refactor|create|delete)\b/.test(text)) return 'code_change';
  if (/\b(run|bash|calculate|compute|read|inspect|list)\b/.test(text)) return 'tool_loop';
  return 'answer';
}

function defaultToolPolicyForIntent(intent: PlanStepIntent): PlanStepToolPolicy {
  if (intent === 'answer' || intent === 'ask_user') return 'none';
  if (intent === 'tool_loop') return 'safe';
  if (intent === 'verify') return 'verify';
  return 'code_write';
}

function isArithmeticPrompt(prompt: string): boolean {
  const normalized = prompt.replace(/[,，\s]/g, '');
  return /[0-9][0-9+\-*/().%^]+[0-9]/.test(normalized)
    && /(多少|等于|算|calculate|compute|what'?s|what is|=|\?|\？)/i.test(prompt);
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
