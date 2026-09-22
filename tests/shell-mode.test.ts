import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runShellCommand } from '../src/infra/tools.js';

test('runShellCommand streams output and reports the exit code', async () => {
  const chunks: string[] = [];
  const result = await runShellCommand('echo hello-stream && echo err-line >&2', {
    workspaceRoot: process.cwd(),
    onChunk: (text) => chunks.push(text),
    timeoutMs: 15_000,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /hello-stream/);
  assert.match(result.output, /err-line/);
  // Every streamed chunk is part of the final output.
  assert.ok(chunks.join('').includes('hello-stream'));
});

test('runShellCommand reports nonzero exit codes without throwing', async () => {
  const result = await runShellCommand('exit 3', {
    workspaceRoot: process.cwd(),
    timeoutMs: 15_000,
  });
  assert.equal(result.exitCode, 3);
});

test('runShellCommand resolves relative commands against the workspace root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maw-shell-cwd-'));
  try {
    // Windows runs cmd.exe, where `pwd` is whatever a POSIX pwd.exe happens to
    // be on PATH (MSYS prints /tmp-style paths) — probe via node instead.
    const command = process.platform === 'win32'
      ? 'node -p process.cwd()'
      : 'pwd';
    const result = await runShellCommand(command, {
      workspaceRoot: dir,
      timeoutMs: 15_000,
    });
    assert.equal(result.exitCode, 0);
    // macOS reports /tmp paths through their /private symlink.
    assert.equal(result.output.trim(), realpathSync(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runShellCommand aborts a long-running process on signal', async () => {
  const controller = new AbortController();
  const pending = runShellCommand('sleep 30', {
    workspaceRoot: process.cwd(),
    signal: controller.signal,
    timeoutMs: 60_000,
  });
  setTimeout(() => controller.abort(), 150);
  const result = await pending;
  assert.equal(result.exitCode, undefined);
  assert.match(result.output, /\(stopped\)/);
});

test('runShellCommand surfaces timeout as a note instead of throwing', async () => {
  const result = await runShellCommand('sleep 30', {
    workspaceRoot: process.cwd(),
    timeoutMs: 300,
  });
  assert.equal(result.exitCode, undefined);
  assert.match(result.output, /timed out/);
});

test('runShellCommand reports exit 127 for unknown commands', async () => {
  const result = await runShellCommand('definitely-not-a-real-command-xyz', {
    workspaceRoot: process.cwd(),
    timeoutMs: 15_000,
  });
  // POSIX shells standardize "command not found" as 127; cmd.exe does not
  // (observed 1 or 9009 depending on Windows version), so just require nonzero.
  if (process.platform === 'win32') {
    assert.notEqual(result.exitCode, 0);
  } else {
    assert.equal(result.exitCode, 127);
  }
});
