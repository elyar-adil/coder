import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_SYSTEM_PROMPT,
  MASTER_QUERY_SYSTEM_PROMPT,
  MASTER_ROUTER_SYSTEM_PROMPT,
  MASTER_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  PRESENTATION_SYSTEM_PROMPT,
  STEP_EXECUTOR_SYSTEM_PROMPT,
  WORKER_SYSTEM_PROMPT,
} from '../src/infra/prompts.js';

describe('prompt language policy', () => {
  it('keeps user-visible model output in the latest user language', () => {
    const prompts = [
      MASTER_SYSTEM_PROMPT,
      MASTER_ROUTER_SYSTEM_PROMPT,
      MASTER_QUERY_SYSTEM_PROMPT,
      PRESENTATION_SYSTEM_PROMPT,
      PLANNER_SYSTEM_PROMPT,
      WORKER_SYSTEM_PROMPT,
      STEP_EXECUTOR_SYSTEM_PROMPT,
      CHAT_SYSTEM_PROMPT,
    ];

    for (const prompt of prompts) {
      assert.match(prompt, /Match the latest user's natural language/);
      assert.match(prompt, /If the latest user prompt is Chinese/);
    }
  });

  it('teaches agents to use explicit download markers only for artifacts', () => {
    assert.match(PRESENTATION_SYSTEM_PROMPT, /\[\[download:\/path\/to\/file\.ext\]\]/);
    assert.match(PRESENTATION_SYSTEM_PROMPT, /Do not mark ordinary/);
    assert.match(WORKER_SYSTEM_PROMPT, /\[\[download:\/path\/to\/file\.ext\]\]/);
    assert.match(WORKER_SYSTEM_PROMPT, /ordinary repository\/source paths/);
  });

});
