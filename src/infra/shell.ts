import { spawn, type ChildProcess } from 'node:child_process';
import stripAnsi from 'strip-ansi';

/**
 * Shell execution for the `bash` tool.
 *
 * Compared with `child_process.exec`, this:
 *  - reports the exit code, the terminating signal, and a timeout explicitly,
 *    so the model can tell "tests failed" from "the command hung";
 *  - kills the whole process group on timeout/abort, so `npm test` and its
 *    children do not outlive the call as orphans;
 *  - closes stdin, so a command that waits for input fails fast instead of
 *    blocking until the timeout;
 *  - returns once the shell exits even if a background process still holds the
 *    output pipes open (`server &` must not block the call until the timeout);
 *  - strips ANSI escapes and collapses progress-bar redraws before the text is
 *    handed to the model.
 */

export interface ShellOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Per-stream cap in bytes; output beyond it is dropped but still drained. */
  maxBytes?: number;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  /** The shell exited but a background process kept the output pipes open. */
  lingering: boolean;
  spawnError?: string;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
const PIPE_FLUSH_GRACE_MS = 300;

/** Environment that keeps common tools from blocking on a terminal that is not there. */
const NON_INTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
};

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

class CappedBuffer {
  readonly #chunks: Buffer[] = [];
  #length = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    const room = this.max - this.#length;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length > room) {
      this.#chunks.push(chunk.subarray(0, room));
      this.#length += room;
      this.truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#length += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}

export function runShell(command: string, options: ShellOptions): Promise<ShellResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const empty: ShellResult = {
    stdout: '', stderr: '', exitCode: null, signal: null,
    timedOut: false, aborted: false, truncated: false, lingering: false,
  };
  if (options.signal?.aborted) return Promise.resolve({ ...empty, aborted: true });

  return new Promise((resolvePromise) => {
    const stdout = new CappedBuffer(maxBytes);
    const stderr = new CappedBuffer(maxBytes);
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let timedOut = false;
    let aborted = false;
    let lingering = false;
    let spawnError: string | undefined;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let flushTimer: NodeJS.Timeout | undefined;

    let child: ChildProcess;
    try {
      child = spawn(command, {
        shell: true,
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A process group lets a timeout kill the command's children too.
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: { ...process.env, ...NON_INTERACTIVE_ENV },
      });
    } catch (error) {
      resolvePromise({ ...empty, spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }

    const onAbort = (): void => {
      aborted = true;
      killTree(child, 'SIGTERM');
      killTimer ??= setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(flushTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode,
        signal: exitSignal,
        timedOut,
        aborted,
        truncated: stdout.truncated || stderr.truncated,
        lingering,
        ...(spawnError ? { spawnError } : {}),
      });
    };

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      spawnError = error.message;
      finish();
    });
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // Normally 'close' follows immediately. If a background process still
      // holds the pipes, stop waiting for it after a short flush window.
      flushTimer = setTimeout(() => {
        lingering = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, PIPE_FLUSH_GRACE_MS);
      flushTimer.unref();
    });
    child.on('close', (code, signal) => {
      exitCode = code ?? exitCode;
      exitSignal = signal ?? exitSignal;
      finish();
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    }, options.timeoutMs);
    timeoutTimer.unref();
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Normalize terminal output for the model: no colors, no progress-bar redraw spam. */
export function cleanTerminalText(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n/g, '\n')
    // A bare \r rewinds the line (progress bars, spinners); keep what was drawn last.
    .replace(/[^\n]*\r(?!\n)/g, '');
}

function joinStreams(result: ShellResult): string {
  const out = cleanTerminalText(result.stdout);
  const err = cleanTerminalText(result.stderr);
  return [out, err].filter(Boolean).join('\n--- stderr ---\n');
}

/**
 * Text returned to the model. A clean exit keeps the plain output format; any
 * other outcome starts with an explicit `Error:` line naming the cause.
 */
export function formatShellResult(result: ShellResult, options: { cwd: string; timeoutMs: number }): string {
  if (result.spawnError) return `Error: cannot run command in ${options.cwd}: ${result.spawnError}`;
  const output = joinStreams(result);
  const notes: string[] = [];
  if (result.truncated) notes.push('output was truncated at the capture limit');
  if (result.lingering) notes.push('the command exited but a background process is still running; returned without waiting for it');
  const footer = notes.length ? `\n(${notes.join('; ')})` : '';

  if (result.aborted) return `Error: command aborted${output ? `\n${output}` : ''}${footer}`;
  if (result.timedOut) {
    return `Error: command timed out after ${options.timeoutMs}ms and was killed (raise timeout_ms, up to 300000, or run it in the background)${output ? `\nOutput so far:\n${output}` : ''}${footer}`;
  }
  if (result.signal) return `Error: command terminated by signal ${result.signal}${output ? `\n${output}` : ''}${footer}`;
  if (result.exitCode !== 0) return `Error: command failed (exit code ${result.exitCode ?? 'unknown'})${output ? `\n${output}` : ''}${footer}`;
  return (output || '(no output)') + footer;
}
