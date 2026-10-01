import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TraceEvent } from './trace.js';

export interface ToolStats {
  tool: string;
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

export interface TraceSummary {
  sessionId: string;
  startedAt?: string;
  endedAt?: string;
  userMessages: number;
  turns: { count: number; totalMs: number; maxMs: number; failed: number };
  /** Model requests, and the most any single turn needed. */
  requests: { total: number; maxInOneTurn: number };
  tokens: { input: number; output: number; cached: number; reasoning: number };
  tools: ToolStats[];
  topErrors: Array<{ tool: string; message: string; count: number }>;
  compactions: number;
  notices: string[];
  runtimeErrors: string[];
}

export function parseTrace(text: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line) as TraceEvent); } catch { /* a half-written last line is skipped */ }
  }
  return events;
}

/** First line of an error, with volatile detail (absolute paths, numbers) folded so identical failures group together. */
function errorKey(output: string): string {
  const first = output.split('\n')[0]!.trim();
  return first.replace(/\/[^\s'"`:,)]+/g, '<path>').replace(/\b\d+\b/g, 'N').slice(0, 160);
}

export function summarizeTrace(sessionId: string, events: TraceEvent[]): TraceSummary {
  const tools = new Map<string, ToolStats>();
  const errors = new Map<string, { tool: string; message: string; count: number }>();
  const stepsPerTurn = new Map<string, number>();
  const summary: TraceSummary = {
    sessionId,
    userMessages: 0,
    turns: { count: 0, totalMs: 0, maxMs: 0, failed: 0 },
    requests: { total: 0, maxInOneTurn: 0 },
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
    tools: [],
    topErrors: [],
    compactions: 0,
    notices: [],
    runtimeErrors: [],
  };

  for (const event of events) {
    const at = new Date(event.t).toISOString();
    summary.startedAt ??= at;
    summary.endedAt = at;
    switch (event.ev) {
      case 'user': summary.userMessages += 1; break;
      case 'step': {
        const key = `${event.instance}:${event.turn}`;
        stepsPerTurn.set(key, Math.max(stepsPerTurn.get(key) ?? 0, event.step));
        break;
      }
      case 'tool': {
        const stats = tools.get(event.tool) ?? { tool: event.tool, calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
        stats.calls += 1;
        stats.totalMs += event.ms;
        stats.maxMs = Math.max(stats.maxMs, event.ms);
        if (!event.ok) {
          stats.errors += 1;
          const message = errorKey(event.output);
          const key = `${event.tool}\u0000${message}`;
          const known = errors.get(key) ?? { tool: event.tool, message, count: 0 };
          known.count += 1;
          errors.set(key, known);
        }
        tools.set(event.tool, stats);
        break;
      }
      case 'turn':
        summary.turns.count += 1;
        summary.turns.totalMs += event.ms;
        summary.turns.maxMs = Math.max(summary.turns.maxMs, event.ms);
        if (event.status === 'failed' || event.error) summary.turns.failed += 1;
        summary.tokens.input += event.input ?? 0;
        summary.tokens.output += event.output ?? 0;
        summary.tokens.cached += event.cached ?? 0;
        summary.tokens.reasoning += event.reasoning ?? 0;
        break;
      case 'compact': summary.compactions += 1; break;
      case 'system':
        if (/paused|stuck|repeat/i.test(event.text)) summary.notices.push(event.text);
        break;
      case 'error': summary.runtimeErrors.push(event.error); break;
      default: break;
    }
  }

  for (const steps of stepsPerTurn.values()) {
    summary.requests.total += steps;
    summary.requests.maxInOneTurn = Math.max(summary.requests.maxInOneTurn, steps);
  }
  summary.tools = [...tools.values()].sort((a, b) => b.calls - a.calls);
  summary.topErrors = [...errors.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  return summary;
}

const seconds = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`);
const pct = (part: number, whole: number): string => (whole ? `${Math.round((part / whole) * 100)}%` : '-');

export function formatTraceSummary(summary: TraceSummary): string {
  const out: string[] = [];
  out.push(`Session ${summary.sessionId}${summary.startedAt ? `  (${summary.startedAt} → ${summary.endedAt})` : ''}`);
  out.push(`  user messages: ${summary.userMessages}   turns: ${summary.turns.count}${summary.turns.failed ? ` (${summary.turns.failed} failed)` : ''}   model requests: ${summary.requests.total} (max ${summary.requests.maxInOneTurn} in one turn)`);
  if (summary.turns.count) out.push(`  turn time: total ${seconds(summary.turns.totalMs)}, avg ${seconds(summary.turns.totalMs / summary.turns.count)}, max ${seconds(summary.turns.maxMs)}`);
  const t = summary.tokens;
  if (t.input || t.output) out.push(`  tokens: in ${t.input} (cached ${t.cached}, ${pct(t.cached, t.input)}), out ${t.output}${t.reasoning ? `, reasoning ${t.reasoning}` : ''}`);
  if (summary.compactions) out.push(`  context compactions: ${summary.compactions}`);

  if (summary.tools.length) {
    out.push('', '  tool            calls  errors  avg      max');
    for (const tool of summary.tools) {
      out.push(`  ${tool.tool.padEnd(15)} ${String(tool.calls).padStart(5)}  ${String(tool.errors).padStart(6)}  ${seconds(tool.totalMs / tool.calls).padEnd(7)}  ${seconds(tool.maxMs)}`);
    }
  }
  if (summary.topErrors.length) {
    out.push('', '  most common tool errors:');
    for (const error of summary.topErrors) out.push(`   ${String(error.count).padStart(3)}x ${error.tool}: ${error.message}`);
  }
  if (summary.notices.length) {
    out.push('', '  pauses / loop notices:');
    for (const notice of summary.notices.slice(0, 5)) out.push(`   - ${notice.split('\n')[0]}`);
  }
  if (summary.runtimeErrors.length) {
    out.push('', '  runtime errors:');
    for (const error of summary.runtimeErrors.slice(0, 5)) out.push(`   - ${error.split('\n')[0]}`);
  }
  return out.join('\n');
}

export async function listTraceSessions(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith('.jsonl')).map((file) => file.slice(0, -'.jsonl'.length)).sort();
  } catch {
    return [];
  }
}

export async function loadTrace(dir: string, sessionId: string): Promise<TraceEvent[] | undefined> {
  try {
    return parseTrace(await readFile(join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`), 'utf8'));
  } catch {
    return undefined;
  }
}
