import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { cleanTerminalText, formatShellResult, runShell } from '../src/infra/shell.js';

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'maw-shell-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

/** A zombie is already dead; it only lingers when nothing reaps it (e.g. a minimal container init). */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return true; }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const format = (result: Awaited<ReturnType<typeof runShell>>, timeoutMs = 10_000): string => formatShellResult(result, { cwd: dir, timeoutMs });

describe('runShell', () => {
  test('a clean run keeps the plain output format', async () => {
    const result = await runShell('echo hello', { cwd: dir, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 0);
    assert.equal(format(result).trim(), 'hello');
    assert.equal(format(await runShell('true', { cwd: dir, timeoutMs: 10_000 })), '(no output)');
  });

  test('reports the exit code and labels stderr on failure', async () => {
    const result = await runShell('echo partial; echo broke >&2; exit 3', { cwd: dir, timeoutMs: 10_000 });
    const text = format(result);
    assert.match(text, /^Error: command failed \(exit code 3\)/);
    assert.match(text, /partial/);
    assert.match(text, /--- stderr ---\s*broke/);
  });

  test('a timeout is reported as such and kills the whole process tree', async () => {
    const pidFile = join(dir, 'child.pid');
    await writeFile(join(dir, 'hang.js'), `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.log('started'); setInterval(() => {}, 1000);`);
    // The trailing `true` keeps the shell alive, so node is a grandchild of this call.
    const result = await runShell('node hang.js; true', { cwd: dir, timeoutMs: 700 });
    assert.equal(result.timedOut, true);
    const text = format(result, 700);
    assert.match(text, /^Error: command timed out after 700ms and was killed/);
    assert.match(text, /started/, 'partial output survives the timeout');
    const pid = Number(await readFile(pidFile, 'utf8'));
    await sleep(300);
    assert.equal(alive(pid), false, 'the grandchild must not outlive the call');
  });

  test('stdin is closed, so a command that reads input does not hang', async () => {
    const started = Date.now();
    const result = await runShell('cat', { cwd: dir, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 0);
    assert.ok(Date.now() - started < 5_000);
  });

  test('returns when the shell exits even if a background process keeps the pipes open', async () => {
    await writeFile(join(dir, 'bg.js'), 'setTimeout(() => {}, 4000);');
    const started = Date.now();
    const result = await runShell('node bg.js & echo started', { cwd: dir, timeoutMs: 20_000 });
    assert.ok(Date.now() - started < 3_000, 'must not wait for the background process');
    assert.equal(result.exitCode, 0);
    assert.equal(result.lingering, true);
    const text = format(result, 20_000);
    assert.match(text, /started/);
    assert.match(text, /background process is still running/);
  });

  test('an abort signal stops the command', async () => {
    const controller = new AbortController();
    const running = runShell('sleep 30', { cwd: dir, timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const result = await running;
    assert.equal(result.aborted, true);
    assert.match(format(result), /^Error: command aborted/);
    assert.equal((await runShell('echo no', { cwd: dir, timeoutMs: 5_000, signal: controller.signal })).aborted, true, 'an already-aborted signal never spawns');
  });

  test('output beyond the capture cap is dropped and flagged', async () => {
    await writeFile(join(dir, 'flood.js'), "process.stdout.write('x'.repeat(5000));");
    const result = await runShell('node flood.js', { cwd: dir, timeoutMs: 10_000, maxBytes: 1000 });
    assert.equal(result.stdout.length, 1000);
    assert.match(format(result), /output was truncated/);
  });

  test('an unusable working directory is explained, not a bare ENOENT', async () => {
    const result = await runShell('echo hi', { cwd: join(dir, 'missing'), timeoutMs: 5_000 });
    assert.match(format(result), /^Error: cannot run command in /);
  });
});

describe('cleanTerminalText', () => {
  test('removes ANSI colors and keeps only the last redraw of a progress line', () => {
    assert.equal(cleanTerminalText('\u001b[31mred\u001b[0m\nprogress 1\rprogress 2\rprogress 3\ndone\n'), 'red\nprogress 3\ndone\n');
  });

  test('keeps CRLF line endings intact as plain newlines', () => {
    assert.equal(cleanTerminalText('a\r\nb\r\n'), 'a\nb\n');
  });
});
