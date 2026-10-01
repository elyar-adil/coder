import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentEvent } from '../domain/agent.js';

/**
 * Append-only run trace: one JSON object per line, per session, written next
 * to the session snapshots. It is a pure subscriber to the runtime's events, so
 * recording can never change behavior, and a write failure is swallowed.
 *
 * The trace answers "where did this task go wrong?" after an evaluation run:
 * which tools failed or were slow, how many model requests a turn needed, what
 * was paused or compacted. Tool inputs and outputs are clipped; the full
 * conversation stays in the session snapshot.
 */

const CLIP_CHARS = 400;

export type TraceEvent =
  | { t: number; ev: 'user'; session: string; text: string }
  | { t: number; ev: 'step'; session: string; instance: string; turn: string; step: number }
  | { t: number; ev: 'tool'; session: string; instance: string; turn: string; tool: string; ms: number; ok: boolean; input: string; output: string; chars: number }
  | { t: number; ev: 'turn'; session: string; instance: string; agent: string; status: string; ms: number; input?: number; output?: number; cached?: number; reasoning?: number; error?: string }
  | { t: number; ev: 'reply'; session: string; instance: string; chars: number }
  | { t: number; ev: 'compact'; session: string; instance: string; reason: string; before: number; after: number; archived: number }
  | { t: number; ev: 'system'; session: string; text: string }
  | { t: number; ev: 'error'; session?: string; instance?: string; error: string };

export function clip(text: string, max = CLIP_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Tool results report failure in their text: `Error…`, `PolicyError…`, or a JSON `{"ok":false}`. */
export function toolSucceeded(output: string): boolean {
  const head = output.trimStart();
  if (/^(Error|PolicyError)\b/.test(head)) return false;
  return !/^\{\s*"ok"\s*:\s*false\b/.test(head);
}

export interface TraceRecorderOptions {
  /** Directory the per-session `<id>.jsonl` files go in. */
  dir: string;
  /** Applied to every serialized line before it is written (secret redaction). */
  redact?: (line: string) => string;
  now?: () => number;
}

export class TraceRecorder {
  readonly #dir: string;
  readonly #redact: (line: string) => string;
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #sessionOf = new Map<string, string>();
  readonly #openTools = new Map<string, Array<{ tool: string; input: string; startedAt: number }>>();
  readonly #lastTurnEnd = new Map<string, string>();
  #queue: Promise<void> = Promise.resolve();
  #madeDir = false;

  constructor(options: TraceRecorderOptions) {
    this.#dir = options.dir;
    this.#redact = options.redact ?? ((line) => line);
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
  }

  /** Resolves once every line recorded so far has been written. */
  flush(): Promise<void> {
    return this.#queue;
  }

  record(event: AgentEvent): void {
    try {
      this.#handle(event);
    } catch {
      // Tracing must never affect the run.
    }
  }

  #sessionFor(instanceId: string | undefined): string {
    return (instanceId && this.#sessionOf.get(instanceId)) || 'unknown';
  }

  #write(session: string, entry: TraceEvent): void {
    const line = this.#redact(`${JSON.stringify(entry)}\n`);
    const path = join(this.#dir, `${session.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
    this.#queue = this.#queue.then(async () => {
      if (!this.#madeDir) {
        await mkdir(dirname(path), { recursive: true });
        this.#madeDir = true;
      }
      await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
    }).catch(() => undefined);
  }

  #handle(event: AgentEvent): void {
    const t = this.#now();
    switch (event.type) {
      case 'instance_created':
        this.#sessionOf.set(event.instance.instanceId, event.instance.sessionId);
        return;
      case 'instance_updated': {
        const instance = event.instance;
        this.#sessionOf.set(instance.instanceId, instance.sessionId);
        const turn = instance.lastTurn;
        if (!turn || this.#lastTurnEnd.get(instance.instanceId) === turn.endedAt) return;
        this.#lastTurnEnd.set(instance.instanceId, turn.endedAt);
        // A resumed session carries turns from earlier runs; only record ones that ended during this run.
        if (Date.parse(turn.endedAt) < this.#startedAt) return;
        this.#write(instance.sessionId, {
          t, ev: 'turn', session: instance.sessionId, instance: instance.instanceId, agent: instance.agentId,
          status: instance.status, ms: turn.durationMs,
          ...(turn.usage?.inputTokens !== undefined ? { input: turn.usage.inputTokens } : {}),
          ...(turn.usage?.outputTokens !== undefined ? { output: turn.usage.outputTokens } : {}),
          ...(turn.usage?.cachedInputTokens !== undefined ? { cached: turn.usage.cachedInputTokens } : {}),
          ...(turn.usage?.reasoningTokens !== undefined ? { reasoning: turn.usage.reasoningTokens } : {}),
          ...(instance.lastError ? { error: clip(instance.lastError) } : {}),
        });
        return;
      }
      case 'user_message':
        this.#write(event.sessionId, { t, ev: 'user', session: event.sessionId, text: clip(event.message.content) });
        return;
      case 'turn_progress':
        this.#write(event.sessionId, { t, ev: 'step', session: event.sessionId, instance: event.instanceId, turn: event.turnId, step: event.step });
        return;
      case 'tool_started': {
        const stack = this.#openTools.get(event.instanceId) ?? [];
        stack.push({ tool: event.tool, input: event.input, startedAt: t });
        this.#openTools.set(event.instanceId, stack);
        return;
      }
      case 'tool_finished': {
        const stack = this.#openTools.get(event.instanceId) ?? [];
        const index = stack.map((open) => open.tool).lastIndexOf(event.tool);
        const open = index >= 0 ? stack.splice(index, 1)[0] : undefined;
        this.#write(this.#sessionFor(event.instanceId), {
          t, ev: 'tool', session: this.#sessionFor(event.instanceId), instance: event.instanceId, turn: event.turnId, tool: event.tool,
          ms: open ? t - open.startedAt : 0, ok: toolSucceeded(event.output),
          input: clip(open?.input ?? ''), output: clip(event.output), chars: event.output.length,
        });
        return;
      }
      case 'assistant_message':
        this.#write(event.sessionId, { t, ev: 'reply', session: event.sessionId, instance: event.instanceId, chars: event.message.content.length });
        return;
      case 'context_compacted':
        this.#write(event.sessionId, { t, ev: 'compact', session: event.sessionId, instance: event.instanceId, reason: event.reason, before: event.charsBefore, after: event.charsAfter, archived: event.archivedMessages });
        return;
      case 'system_message':
        this.#write(event.sessionId, { t, ev: 'system', session: event.sessionId, text: clip(event.message.content) });
        return;
      case 'runtime_error':
        this.#write(event.sessionId ?? this.#sessionFor(event.instanceId), { t, ev: 'error', ...(event.sessionId ? { session: event.sessionId } : {}), ...(event.instanceId ? { instance: event.instanceId } : {}), error: clip(event.error) });
        return;
      default:
        return;
    }
  }
}
