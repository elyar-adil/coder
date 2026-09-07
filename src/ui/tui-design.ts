import type { AgentInstanceStatus } from '../domain/agent.js';
import type { SessionTimelineEntry } from '../domain/agent.js';

export type ActivityLayout = 'hidden' | 'split' | 'overlay';

export interface TuiLayout {
  activity: ActivityLayout;
  activityWidth: number;
  conversationWidth: number;
  horizontalPadding: number;
  showSecondaryStatus: boolean;
}

/** Stable layout breakpoints keep the transcript readable when Agents is open. */
export function tuiLayout(width: number, activityRequested: boolean): TuiLayout {
  const columns = Math.max(20, Math.floor(width));
  const horizontalPadding = columns < 64 ? 1 : 2;
  if (!activityRequested) {
    return { activity: 'hidden', activityWidth: 0, conversationWidth: columns, horizontalPadding, showSecondaryStatus: columns >= 58 };
  }
  if (columns >= 110) {
    const activityWidth = Math.min(38, Math.max(32, Math.floor(columns * 0.3)));
    return { activity: 'split', activityWidth, conversationWidth: columns - activityWidth, horizontalPadding, showSecondaryStatus: true };
  }
  const activityWidth = columns < 64 ? columns : Math.min(38, Math.floor(columns * 0.46));
  return { activity: 'overlay', activityWidth, conversationWidth: columns, horizontalPadding, showSecondaryStatus: columns >= 58 };
}

export const STATUS_PRESENTATION: Record<AgentInstanceStatus, { icon: string; label: string; tone: 'muted' | 'accent' | 'success' | 'warning' | 'error' }> = {
  queued: { icon: '○', label: 'Queued', tone: 'muted' },
  running: { icon: '●', label: 'Running', tone: 'accent' },
  idle: { icon: '✓', label: 'Done', tone: 'success' },
  waiting: { icon: '◌', label: 'Waiting', tone: 'warning' },
  failed: { icon: '!', label: 'Failed', tone: 'error' },
  cancelled: { icon: '×', label: 'Stopped', tone: 'muted' },
};

const TOOL_LABELS: Record<string, string> = {
  bash: 'Run',
  edit_file: 'Edit',
  file_info: 'Inspect',
  git_diff: 'Review changes',
  git_log: 'Read history',
  git_status: 'Check repository',
  list_dir: 'List files',
  load_skill: 'Load skill',
  read_file: 'Read',
  read_files: 'Read files',
  repo_map: 'Map repository',
  search_files: 'Find files',
  search_history: 'Search history',
  search_text: 'Search',
  spawn_agent: 'Start agent',
  send_agent: 'Message agent',
  wait_agent: 'Wait for agent',
  cancel_agent: 'Stop agent',
  compact_context: 'Compact context',
  web_search: 'Search web',
  write_file: 'Write',
};

function parsedInput(input: string | undefined): Record<string, unknown> {
  if (!input) return {};
  try {
    const value = JSON.parse(input) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
}

export function toolPresentation(tool: string, input?: string): { label: string; detail?: string } {
  const values = parsedInput(input);
  const label = TOOL_LABELS[tool] ?? tool.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
  let detail = firstString(values, ['path', 'query', 'glob', 'command', 'agent', 'instance_id', 'name']);
  if (!detail && tool === 'read_files' && Array.isArray(values.paths)) detail = values.paths.filter((value) => typeof value === 'string').slice(0, 2).join(', ');
  return { label, ...(detail ? { detail: detail.replace(/\s+/g, ' ') } : {}) };
}

export function elapsedLabel(startedAt: number | undefined, currentTime = Date.now()): string {
  if (!startedAt) return '';
  const seconds = Math.max(0, Math.floor((currentTime - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function diffPreview(diff: string, maxLines = 12): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines + 2) return diff;
  const fence = lines.at(-1)?.trim() === '```';
  const body = lines.slice(0, maxLines + 1);
  const hidden = lines.length - body.length - (fence ? 1 : 0);
  body.push(`... ${hidden} more lines`, ...(fence ? ['```'] : []));
  return body.join('\n');
}

export function visibleTimelineEntries(entries: SessionTimelineEntry[], limit = 400): { entries: SessionTimelineEntry[]; omitted: number } {
  const safeLimit = Math.max(1, Math.floor(limit));
  const omitted = Math.max(0, entries.length - safeLimit);
  return { entries: omitted ? entries.slice(omitted) : entries, omitted };
}
