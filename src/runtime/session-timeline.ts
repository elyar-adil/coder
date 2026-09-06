import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentSession, SessionTimelineEntry } from '../domain/agent.js';

/** Record display order at event time, not grouped retrospectively by turn. */
export function recordTimeline(session: AgentSession, event: AgentEvent): void {
  const entries: SessionTimelineEntry[] = session.timeline ??= session.messages.map<SessionTimelineEntry>(message => ({
    id: message.messageId, kind: 'message', role: message.role,
    turnId: message.turnId, content: message.content, status: 'completed',
  }));
  if (event.type === 'user_message') {
    if (!entries.some(entry => entry.id === event.message.messageId)) entries.push({
      id: event.message.messageId, kind: 'message', role: 'user', content: event.message.content,
      turnId: event.message.turnId, status: 'completed',
    });
    return;
  }
  if (!('instanceId' in event) || !event.instanceId) {
    if (event.type === 'instance_updated' && ['idle', 'failed', 'cancelled', 'queued'].includes(event.instance.status)) {
      for (const entry of entries) if (entry.instanceId === event.instance.instanceId && entry.status === 'running') {
        entry.status = event.instance.status === 'failed' ? 'failed' : event.instance.status === 'cancelled' || event.instance.status === 'queued' ? 'cancelled' : 'completed';
      }
    }
    return;
  }
  const own = () => entries.filter(entry => entry.instanceId === event.instanceId && entry.status === 'running');
  if (event.type === 'thinking_delta' || event.type === 'assistant_delta') {
    const kind = event.type === 'thinking_delta' ? 'thinking' : 'message';
    let entry = own().at(-1);
    if (!entry || entry.kind !== kind || entry.turnId !== event.turnId) {
      for (const previous of own()) if (previous.kind !== 'tool') previous.status = 'completed';
      entry = { id: randomUUID(), kind, instanceId: event.instanceId, turnId: event.turnId,
        role: 'assistant', content: '', status: 'running' };
      entries.push(entry);
    }
    entry.content += event.text;
  } else if (event.type === 'assistant_message') {
    for (const entry of own()) if (entry.kind !== 'tool') entry.status = 'completed';
  } else if (event.type === 'tool_started') {
    for (const entry of own()) if (entry.kind !== 'tool') entry.status = 'completed';
    entries.push({ id: randomUUID(), kind: 'tool', instanceId: event.instanceId,
      turnId: event.turnId, tool: event.tool, input: event.input, content: '', status: 'running' });
  } else if (event.type === 'tool_finished') {
    const entry = own().find(entry => entry.kind === 'tool' && entry.tool === event.tool && entry.turnId === event.turnId);
    if (entry) {
      entry.content = event.output;
      entry.status = /^(?:\w*Error:|Error\b)|"ok"\s*:\s*false/.test(event.output) ? 'failed' : 'completed';
    }
  }
}
