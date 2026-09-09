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
