/**
 * tests/tools.test.ts
 *
 * Unit tests for executeTool — the four agent tools:
 *   read_file, write_file, list_dir, bash
 *
 * Uses Node.js built-in test runner (node:test) — no extra deps.
 * Run with:  node --import tsx/esm --test tests/tools.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { executeTool } from '../src/tools.js';

// ── Temp directory shared across tests ───────────────────────────────────────
let tmpDir: string;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'agent-tools-test-'));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── read_file ─────────────────────────────────────────────────────────────────
describe('read_file', () => {
  test('reads an existing file', async () => {
    const path = join(tmpDir, 'hello.txt');
    await writeFile(path, 'hello world', 'utf8');
    const result = await executeTool('read_file', { path });
    assert.equal(result, '00001|hello world');
  });

  test('returns error string for missing file', async () => {
    const result = await executeTool('read_file', { path: join(tmpDir, 'nonexistent.txt') });
    assert.match(result, /Error reading file/);
  });

  test('returns error when path arg is missing', async () => {
    const result = await executeTool('read_file', {});
    assert.equal(result, 'Error: read_file requires "path"');
  });

  test('reads a file with unicode content', async () => {
    const path = join(tmpDir, 'unicode.txt');
    const content = '你好世界 🌍\nline2';
    await writeFile(path, content, 'utf8');
    const result = await executeTool('read_file', { path });
    assert.equal(result, '00001|你好世界 🌍\n00002|line2');
  });

  test('reads an empty file', async () => {
    const path = join(tmpDir, 'empty.txt');
    await writeFile(path, '', 'utf8');
    const result = await executeTool('read_file', { path });
    assert.equal(result, '');
  });
});


// ── edit_file ────────────────────────────────────────────────────────────────
describe('edit_file', () => {
  test('edits a block copied from line-numbered read_file output', async () => {
    const path = join(tmpDir, 'line-number-edit.txt');
    await writeFile(path, 'alpha\nbeta\ngamma', 'utf8');
    const readResult = await executeTool('read_file', { path, offset: 2, limit: 1 });

    const result = await executeTool('edit_file', {
      path,
      edits: JSON.stringify([{ search: readResult, replace: 'BETA' }]),
    });

    assert.match(result, /line-number normalized/);
    assert.equal(await readFile(path, 'utf8'), 'alpha\nBETA\ngamma');
  });

  test('accepts already-parsed edit arrays from tool-call arguments', async () => {
    const path = join(tmpDir, 'array-edit.txt');
    await writeFile(path, 'old value', 'utf8');

    const result = await executeTool('edit_file', {
      path,
      edits: [{ search: 'old', replace: 'new' }],
    });

    assert.match(result, /^OK:/);
    assert.equal(await readFile(path, 'utf8'), 'new value');
  });

  test('edits simple relative artifacts in the session artifact directory', async () => {
    const artifactDir = join(tmpDir, 'edit-artifacts');
    const artifactPath = join(artifactDir, 'notes.txt');
    await executeTool('write_file', { path: 'notes.txt', content: 'draft artifact' }, {
      spawnSubagent: async () => '',
      collectSubagent: async () => '',
      artifactDir,
    });

    const result = await executeTool('edit_file', {
      path: 'notes.txt',
      edits: JSON.stringify([{ search: 'draft', replace: 'final' }]),
    }, {
      spawnSubagent: async () => '',
      collectSubagent: async () => '',
      artifactDir,
    });

    assert.match(result, new RegExp(artifactPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(await readFile(artifactPath, 'utf8'), 'final artifact');
  });
});

// ── write_file ────────────────────────────────────────────────────────────────
describe('write_file', () => {
  test('creates a new file', async () => {
    const path = join(tmpDir, 'new.txt');
    const result = await executeTool('write_file', { path, content: 'created' });
    assert.match(result, /^OK: wrote/);
    const actual = await readFile(path, 'utf8');
    assert.equal(actual, 'created');
  });

  test('overwrites an existing file', async () => {
    const path = join(tmpDir, 'overwrite.txt');
    await writeFile(path, 'old content', 'utf8');
    await executeTool('write_file', { path, content: 'new content' });
    const actual = await readFile(path, 'utf8');
    assert.equal(actual, 'new content');
  });

  test('creates intermediate directories', async () => {
    const path = join(tmpDir, 'a', 'b', 'c', 'deep.txt');
    const result = await executeTool('write_file', { path, content: 'deep' });
    assert.match(result, /^OK: wrote/);
    const actual = await readFile(path, 'utf8');
    assert.equal(actual, 'deep');
  });

  test('reports char count in success message', async () => {
    const path = join(tmpDir, 'count.txt');
    const content = 'abcde';
    const result = await executeTool('write_file', { path, content });
    assert.match(result, /5 chars/);
  });

  test('returns error when path is missing', async () => {
    const result = await executeTool('write_file', { content: 'x' });
    assert.equal(result, 'Error: write_file requires "path"');
  });

  test('returns error when content is missing', async () => {
    const result = await executeTool('write_file', { path: join(tmpDir, 'x.txt') });
    assert.equal(result, 'Error: write_file requires "content"');
  });

  test('writes multiline content correctly', async () => {
    const path = join(tmpDir, 'multi.txt');
    const content = 'line1\nline2\nline3';
    await executeTool('write_file', { path, content });
    const actual = await readFile(path, 'utf8');
    assert.equal(actual, content);
  });

  test('writes simple relative artifacts into the session artifact directory', async () => {
    const artifactDir = join(tmpDir, 'session-artifacts');
    const result = await executeTool('write_file', { path: 'deck.pptx', content: 'ppt' }, {
      spawnSubagent: async () => '',
      collectSubagent: async () => '',
      artifactDir,
    });
    const artifactPath = join(artifactDir, 'deck.pptx');
    assert.match(result, new RegExp(artifactPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(await readFile(artifactPath, 'utf8'), 'ppt');
  });
});

// ── list_dir ──────────────────────────────────────────────────────────────────
describe('list_dir', () => {
  test('lists files and directories', async () => {
    const dir = join(tmpDir, 'listtest');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'file1.txt'), '');
    await writeFile(join(dir, 'file2.ts'), '');
    await mkdir(join(dir, 'subdir'));

    const result = await executeTool('list_dir', { path: dir });
    assert.match(result, /\[file\] file1\.txt/);
    assert.match(result, /\[file\] file2\.ts/);
    assert.match(result, /\[dir\]  subdir/);
  });

  test('returns empty directory message', async () => {
    const dir = join(tmpDir, 'emptydir');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const result = await executeTool('list_dir', { path: dir });
    assert.equal(result, '(empty directory)');
  });

  test('returns error for nonexistent directory', async () => {
    const result = await executeTool('list_dir', { path: join(tmpDir, 'nope') });
    assert.match(result, /Error listing directory/);
  });

  test('defaults to "." when path is missing', async () => {
    // Should not throw — just list cwd
    const result = await executeTool('list_dir', {});
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });
});

// ── bash ──────────────────────────────────────────────────────────────────────
describe('bash', () => {
  test('runs a simple echo command', async () => {
    const result = await executeTool('bash', { command: 'echo hello' });
    assert.match(result, /hello/);
  });

  test('captures stdout', async () => {
    const result = await executeTool('bash', { command: 'node -e "process.stdout.write(\'stdout-test\')"' });
    assert.match(result, /stdout-test/);
  });

  test('captures stderr on non-zero exit', async () => {
    const result = await executeTool('bash', { command: 'node -e "process.stderr.write(\'err-out\'); process.exit(1)"' });
    assert.match(result, /err-out/);
  });

  test('returns (no output) for silent command', async () => {
    const result = await executeTool('bash', { command: 'node -e ""' });
    assert.equal(result, '(no output)');
  });

  test('returns error when command is missing', async () => {
    const result = await executeTool('bash', {});
    assert.equal(result, 'Error: bash requires "command"');
  });

  test('can write and read a file via bash', async () => {
    const path = join(tmpDir, 'bash-written.txt').replace(/\\/g, '/');
    await executeTool('bash', { command: `node -e "require('fs').writeFileSync('${path}', 'bash-content')"` });
    const content = await readFile(join(tmpDir, 'bash-written.txt'), 'utf8');
    assert.equal(content, 'bash-content');
  });

  test('runs multi-command pipeline', async () => {
    const result = await executeTool('bash', { command: 'node -e "console.log(1+1)"' });
    assert.match(result, /2/);
  });

  test('runs bash from the session artifact directory when configured', async () => {
    const artifactDir = join(tmpDir, 'bash-artifacts');
    const result = await executeTool('bash', {
      command: 'node -e "const fs=require(\'fs\'); fs.writeFileSync(\'artifact.txt\', process.cwd());"',
    }, {
      spawnSubagent: async () => '',
      collectSubagent: async () => '',
      artifactDir,
    });
    assert.equal(result, '(no output)');
    assert.equal(await readFile(join(artifactDir, 'artifact.txt'), 'utf8'), await realpath(artifactDir));
  });
});

// ── submit_patch ─────────────────────────────────────────────────────────────
describe('submit_patch', () => {
  test('parses patch input and delegates to writer context', async () => {
    const path = join(tmpDir, 'patch-target.txt');
    let seenSummary = '';
    let seenFiles = 0;
    let seenCommands = 0;

    const result = await executeTool('submit_patch', {
      summary: 'patch summary',
      files: JSON.stringify([{ path, after: 'patched' }]),
      verificationCommands: JSON.stringify(['npm test']),
    }, {
      spawnSubagent: async () => '',
      collectSubagent: async () => '',
      submitPatch: async (patch) => {
        seenSummary = patch.summary;
        seenFiles = patch.files.length;
        seenCommands = patch.verificationCommands.length;
        return 'WriterApplied: ok';
      },
    });

    assert.equal(result, 'WriterApplied: ok');
    assert.equal(seenSummary, 'patch summary');
    assert.equal(seenFiles, 1);
    assert.equal(seenCommands, 1);
  });
});

// ── request_clarification ───────────────────────────────────────────────────
describe('request_clarification', () => {
  test('accepts array choices from tool-call arguments', async () => {
    let seenChoices: string[] | undefined;

    const result = await executeTool('request_clarification', {
      question: 'Pick one.',
      choices: ['Option A', 'Option B'],
    }, {
      spawnSubagent: async () => '',
      collectSubagent: async () => '',
      requestClarification: async (_question, choices) => {
        seenChoices = choices;
        return 'Option A';
      },
    });

    assert.equal(result, 'Option A');
    assert.deepEqual(seenChoices, ['Option A', 'Option B']);
  });
});

// ── unknown tool ──────────────────────────────────────────────────────────────
describe('unknown tool', () => {
  test('returns error for unknown tool name', async () => {
    const result = await executeTool('teleport', { destination: 'mars' });
    assert.equal(result, 'Error: unknown tool "teleport"');
  });
});
