import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSession, SessionTimelineEntry } from '../src/domain/agent.js';
import { recordTimeline } from '../src/runtime/session-timeline.js';

test('timeline updates stay indexed after a long history', () => {
  const raw = Array.from({ length: 10_000 }, (_, index): SessionTimelineEntry => ({
    id: String(index), kind: 'message', instanceId: 'main', role: 'assistant',
    content: `old ${index}`, status: 'completed',
  }));
  let indexedReads = 0;
  const timeline = new Proxy(raw, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) indexedReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const session: AgentSession = {
    sessionId: 'long', mainInstanceId: 'main', messages: [], instanceIds: ['main'],
    createdAt: '', updatedAt: '', timeline,
  };
  const event = { type: 'assistant_delta' as const, sessionId: 'long', instanceId: 'main', turnId: 'turn', text: 'a' };
  recordTimeline(session, event);
  indexedReads = 0;
  recordTimeline(session, { ...event, text: 'b' });
  assert.ok(indexedReads < 10, `expected indexed update, observed ${indexedReads} historic entry reads`);
  assert.equal(session.timeline?.at(-1)?.content, 'ab');
});

test('system_message events become system timeline entries', () => {
  const session: AgentSession = {
    sessionId: 'sys', mainInstanceId: 'main', messages: [], instanceIds: ['main'],
    createdAt: '', updatedAt: '',
  };
  recordTimeline(session, { type: 'system_message', sessionId: 'sys', message: { messageId: 'm1', role: 'system', content: 'Noted. This will be included with your next message without starting a turn.', createdAt: 'now' } });
  assert.equal(session.timeline?.length, 1);
  const entry = session.timeline?.[0];
  assert.equal(entry?.kind, 'message');
  assert.equal(entry?.role, 'system');
  assert.equal(entry?.id, 'm1');
  assert.ok(entry?.content.includes('Noted'));
  recordTimeline(session, { type: 'system_message', sessionId: 'sys', message: { messageId: 'm1', role: 'system', content: 'duplicate', createdAt: 'now' } });
  assert.equal(session.timeline?.length, 1, 'duplicate messageId must not create a second entry');
});

test('each thinking block keeps its own start and end times', () => {
  const session: AgentSession = {
    sessionId: 'timings', mainInstanceId: 'main', messages: [], instanceIds: ['main'],
    createdAt: '', updatedAt: '',
  };
  const think = (turnId: string, text: string) => recordTimeline(session, { type: 'thinking_delta', sessionId: 'timings', instanceId: 'main', turnId, text });
  const tool = (kind: 'started' | 'finished') => recordTimeline(session, { type: kind === 'started' ? 'tool_started' : 'tool_finished', sessionId: 'timings', instanceId: 'main', turnId: 'turn-2', tool: 'read_file', input: 'x', output: 'ok: true' });
  think('turn-1', 'reasoning one');
  const first = session.timeline?.at(-1);
  assert.ok(first?.startedAt, 'thinking entry must record its own start time');
  const firstStart = first.startedAt!;
  // Simulate a first turn that took real time before the second turn begins.
  const firstStartShifted = firstStart - 5_000;
  think('turn-2', 'reasoning two');
  const second = session.timeline?.at(-1);
  assert.ok(second?.startedAt, 'second thinking entry must record its own start time');
  assert.ok(second.startedAt! >= firstStart, `second turn must not inherit the first turn start (${second.startedAt} < ${firstStart})`);
  assert.notEqual(second.id, first.id);
  assert.ok(second.startedAt! - firstStart >= 0);
  // Tool activity ends the previous thinking segment with a frozen end time.
  tool('started');
  assert.equal(first.status, 'completed');
  assert.ok(first.endedAt, 'finished segment must record its own end time');
  assert.ok(first.endedAt! >= firstStartShifted, 'end time must not precede the segment start');
  assert.ok(first.endedAt! >= second.startedAt! - 1, 'end time should be at or after the second segment start');
});

test('replacing a cleared timeline resets its running-entry index', () => {
  const session: AgentSession = {
    sessionId: 'clear', mainInstanceId: 'main', messages: [], instanceIds: ['main'],
    createdAt: '', updatedAt: '', timeline: [],
  };
  recordTimeline(session, { type: 'assistant_delta', sessionId: 'clear', instanceId: 'main', turnId: 'old', text: 'old' });
  session.timeline = [];
  recordTimeline(session, { type: 'assistant_delta', sessionId: 'clear', instanceId: 'main', turnId: 'new', text: 'new' });
  assert.equal(session.timeline.length, 1);
  assert.equal(session.timeline[0]?.turnId, 'new');
});
