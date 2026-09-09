import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentSession, SessionTimelineEntry } from '../domain/agent.js';

const runningEntries = new WeakMap<AgentSession, { entries: SessionTimelineEntry[]; index: Map<string, SessionTimelineEntry[]> }>();

function runningIndex(session: AgentSession, entries: SessionTimelineEntry[]): Map<string, SessionTimelineEntry[]> {
  const cached = runningEntries.get(session);
  if (cached?.entries === entries) return cached.index;
  const index = new Map<string, SessionTimelineEntry[]>();
  for (const entry of entries) {
    if (!entry.instanceId || entry.status !== 'running') continue;
    const active = index.get(entry.instanceId) ?? [];
    active.push(entry);
    index.set(entry.instanceId, active);
  }
  runningEntries.set(session, { entries, index });
  return index;
}

function finish(entries: SessionTimelineEntry[], predicate: (entry: SessionTimelineEntry) => boolean, status: SessionTimelineEntry['status'] = 'completed'): void {
  for (const entry of entries) if (predicate(entry)) entry.status = status;
}

/** Record display order at event time, not grouped retrospectively by turn. */
export function recordTimeline(session: AgentSession, event: AgentEvent): void {
  const entries: SessionTimelineEntry[] = session.timeline ??= session.messages.map<SessionTimelineEntry>(message => ({
    id: message.messageId, kind: 'message', role: message.role,
    turnId: message.turnId, content: message.content, status: 'completed',
  }));
  const index = runningIndex(session, entries);
  if (event.type === 'user_message') {
    if (!entries.some(entry => entry.id === event.message.messageId)) entries.push({
      id: event.message.messageId, kind: 'message', role: 'user', content: event.message.content,
      turnId: event.message.turnId, status: 'completed',
    });
    return;
  }
  if (event.type === 'system_message') {
    if (!entries.some(entry => entry.id === event.message.messageId)) entries.push({
      id: event.message.messageId, kind: 'message', role: 'system', content: event.message.content,
      status: 'completed',
    });
    return;
  }
  if (!('instanceId' in event) || !event.instanceId) {
    if (event.type === 'instance_updated' && ['idle', 'failed', 'cancelled', 'queued'].includes(event.instance.status)) {
      const active = index.get(event.instance.instanceId) ?? [];
      const status = event.instance.status === 'failed' ? 'failed' : event.instance.status === 'cancelled' || event.instance.status === 'queued' ? 'cancelled' : 'completed';
      finish(active, () => true, status);
      index.delete(event.instance.instanceId);
    }
    return;
  }
  const instanceId = event.instanceId;
  const own = () => index.get(instanceId) ?? [];
  if (event.type === 'thinking_delta' || event.type === 'assistant_delta') {
    const kind = event.type === 'thinking_delta' ? 'thinking' : 'message';
    const active = own();
    let entry = active.at(-1);
    if (!entry || entry.kind !== kind || entry.turnId !== event.turnId) {
      finish(active, previous => previous.kind !== 'tool');
      entry = { id: randomUUID(), kind, instanceId: event.instanceId, turnId: event.turnId,
        role: 'assistant', content: '', status: 'running' };
      entries.push(entry);
      index.set(event.instanceId, [...active.filter(previous => previous.status === 'running'), entry]);
    }
    entry.content += event.text;
  } else if (event.type === 'assistant_message') {
    const active = own();
    finish(active, entry => entry.kind !== 'tool');
    const remaining = active.filter(entry => entry.status === 'running');
    if (remaining.length) index.set(event.instanceId, remaining);
    else index.delete(event.instanceId);
  } else if (event.type === 'tool_started') {
    const active = own();
    finish(active, entry => entry.kind !== 'tool');
    const entry: SessionTimelineEntry = { id: randomUUID(), kind: 'tool', instanceId: event.instanceId,
      turnId: event.turnId, tool: event.tool, input: event.input, content: '', status: 'running' };
    entries.push(entry);
    index.set(event.instanceId, [...active.filter(previous => previous.status === 'running'), entry]);
  } else if (event.type === 'tool_finished') {
    const active = own();
    const entry = active.find(entry => entry.kind === 'tool' && entry.tool === event.tool && entry.turnId === event.turnId);
    if (entry) {
      entry.content = event.output;
      entry.status = /^(?:\w*Error:|Error\b)|"ok"\s*:\s*false/.test(event.output) ? 'failed' : 'completed';
      const remaining = active.filter(previous => previous.status === 'running');
      if (remaining.length) index.set(event.instanceId, remaining);
      else index.delete(event.instanceId);
    }
  }
}
