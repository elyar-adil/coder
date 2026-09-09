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
  shell: 'Shell',
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

const WAITING_DOT = '.';
// One full gradient cycle in frames; divisible by 3 so the per-dot phase
// offsets stay evenly spaced.
const WAITING_CYCLE = 24;
const WAITING_PHASES = [0, 1 / 6, 1 / 3];

const isHexColor = (color: string): boolean => /^#[0-9a-fA-F]{6}$/.test(color);

function blendHex(low: string, high: string, intensity: number): string {
  const channels = [0, 1, 2].map((channel) => {
    const from = parseInt(low.slice(1 + channel * 2, 3 + channel * 2), 16);
    const to = parseInt(high.slice(1 + channel * 2, 3 + channel * 2), 16);
    return Math.round(from + (to - from) * intensity);
  });
  return `#${channels.map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Animated ellipsis for the assistant slot while a turn has been submitted but
 * no token has arrived. Pure and deterministic: the frame number is the only
 * input, colors come from the caller, and nothing here touches blessed state.
 * Dots cycle through a gradient between the two colors with per-dot phase
 * offset (eased-cosine interpolation); non-hex colors degrade to a single tag.
 */
export function waitingIndicatorFrame(frame: number, colors: { accent: string; subtle: string }): string {
  const safeFrame = Number.isFinite(frame) ? Math.max(0, Math.floor(frame)) : 0;
  const accent = typeof colors?.accent === 'string' ? colors.accent : '';
  const subtle = typeof colors?.subtle === 'string' ? colors.subtle : '';
  if (isHexColor(accent) && isHexColor(subtle)) {
    const dots = WAITING_PHASES.map((phase, index) => {
      const progress = (((safeFrame % WAITING_CYCLE) / WAITING_CYCLE) + phase) % 1;
      const eased = (1 - Math.cos(progress * Math.PI * 2)) / 2;
      const color = blendHex(subtle, accent, eased);
      return `{${color}-fg}${WAITING_DOT}{/${color}-fg}`;
    });
    return dots.join('');
  }
  const fallback = (isHexColor(accent) ? accent : '') || (isHexColor(subtle) ? subtle : '') || accent || subtle || 'gray';
  return `{${fallback}-fg}...{/${fallback}-fg}`;
}

/** Braille dot glyphs, ordered like the classic "dots" spinner. */
const SPINNER_GLYPHS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Ticks per ease cycle (~0.48s at the 60ms timer cadence). */
const SPINNER_CYCLE = 8;
/** Glyphs advanced per tick while resting (the slow phase). */
const SPINNER_REST = 0.35;
/** Extra glyphs per tick at the top of the beat (the fast phase). */
const SPINNER_SWING = 0.65;

/** Eased per-tick advance: rest → accelerate → sweep → settle. */
const SPINNER_STEPS = Array.from(
  { length: SPINNER_CYCLE },
  (_, k) => SPINNER_REST + SPINNER_SWING * (1 - Math.cos((k / SPINNER_CYCLE) * Math.PI * 2)) / 2,
);
/** Glyphs swept per full ease cycle. */
const SPINNER_TRAVEL = SPINNER_STEPS.reduce((sum, step) => sum + step, 0);
/** Running position at the start of each phase within a cycle. */
const SPINNER_OFFSETS = SPINNER_STEPS.map((_, k) => SPINNER_STEPS.slice(0, k).reduce((sum, step) => sum + step, 0));

/**
 * Eased activity spinner pacing. A fixed interval reads as either sluggish
 * (slow enough to stay calm) or frantic (fast enough to feel alive), so the
 * glyph index instead rides an eased cosine: quick sweeps, then a graceful
 * pause, forever. Position is a running total of the eased per-tick advance,
 * which keeps the spin strictly forward while its speed breathes. Pure and
 * deterministic so callers and tests can scrub the timeline.
 */
export function spinnerGlyphFrame(tick: number): number {
  const safeTick = Number.isFinite(tick) ? Math.max(0, Math.floor(tick)) : 0;
  const cycle = Math.floor(safeTick / SPINNER_CYCLE);
  const offset = SPINNER_OFFSETS[safeTick % SPINNER_CYCLE] ?? 0;
  const travel = cycle * SPINNER_TRAVEL + offset;
  return Math.floor(travel % SPINNER_GLYPHS.length);
}

/** Resolved glyph for an activity tick; falls back to the first glyph. */
export function spinnerGlyph(tick: number): string {
  return SPINNER_GLYPHS[spinnerGlyphFrame(tick)] ?? SPINNER_GLYPHS[0]!;
}

/** A turn is pending with no streamed token yet: show the waiting ellipsis. */
export function isWaitingForFirstToken(state: {
  pendingTurns: number;
  streamingEntries: number;
  runningTimelineEntries: number;
  sessionHasTimeline: boolean;
}): boolean {
  if (state.sessionHasTimeline) {
    return state.pendingTurns > 0 && state.streamingEntries === 0 && state.runningTimelineEntries === 0;
  }
  return false;
}
