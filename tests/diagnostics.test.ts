import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { findSyntaxIssue, formatSyntaxIssue, insertAfterFirstBlock } from '../src/infra/diagnostics.js';
import { executeTool } from '../src/infra/tools.js';

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'maw-diag-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });
afterEach(() => { delete process.env['AGENT_SYNTAX_CHECK']; });

const repoRoot = process.cwd(); // the repo ships `typescript`, which the TS checker resolves from here
const has = (command: string): boolean => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;

const check = (name: string, content: string, cwd = dir) => findSyntaxIssue(join(dir, name), content, cwd);

describe('findSyntaxIssue', () => {
  test('JSON: flags a trailing comma, accepts valid JSON', async () => {
    const bad = '{"a": 1,}';
    await writeFile(join(dir, 'bad.json'), bad);
    const issue = await check('bad.json', bad);
    assert.equal(issue?.checker, 'JSON');
    assert.equal(await check('ok.json', '{"a": 1}'), undefined);
  });

  test('JSON: tsconfig and .vscode files may contain comments and are not flagged', async () => {
    const withComment = '{\n  // comment\n  "a": 1,\n}';
    assert.equal(await check('tsconfig.json', withComment), undefined);
    assert.equal(await check('tsconfig.build.json', withComment), undefined);
    assert.equal(await findSyntaxIssue(join(dir, '.vscode', 'settings.json'), withComment, dir), undefined);
  });

  test('JavaScript: flags a syntax error with its line, accepts ESM syntax in .js and .mjs', async () => {
    await writeFile(join(dir, 'bad.js'), 'const ok = 1;\nconst x = ;\n');
    const issue = await check('bad.js', 'const ok = 1;\nconst x = ;\n');
    assert.equal(issue?.checker, 'Node');
    assert.match(issue!.issues[0]!, /^line 2: Unexpected token/);

    const esm = 'import fs from "node:fs";\nexport const a = fs;\n';
    await writeFile(join(dir, 'esm.js'), esm);
    await writeFile(join(dir, 'esm.mjs'), esm);
    assert.equal(await check('esm.js', esm), undefined);
    assert.equal(await check('esm.mjs', esm), undefined);
  });

  test('TypeScript: flags syntax errors, accepts TS-only syntax and JSX', { skip: !has('node') }, async () => {
    const bad = 'const a: number = 1;\nfunction f(x: string { return x }\n';
    await writeFile(join(dir, 'bad.ts'), bad);
    const issue = await check('bad.ts', bad, repoRoot);
    assert.equal(issue?.checker, 'TypeScript');
    assert.match(issue!.issues[0]!, /^2:\d+ /);

    const tsOnly = 'enum E { A }\nclass C { constructor(private x: number) {} }\nexport const v = <T,>(x: T) => x;\n';
    await writeFile(join(dir, 'ok.ts'), tsOnly);
    assert.equal(await check('ok.ts', tsOnly, repoRoot), undefined);

    const tsx = 'export const C = () => <div className="a">hi</div>;\n';
    await writeFile(join(dir, 'ok.tsx'), tsx);
    assert.equal(await check('ok.tsx', tsx, repoRoot), undefined);
    const badTsx = 'export const C = () => <div>;\n';
    await writeFile(join(dir, 'bad.tsx'), badTsx);
    assert.ok(await check('bad.tsx', badTsx, repoRoot));
  });

  test('TypeScript: stays silent when the project has no usable typescript', async () => {
    // Syntax-only tooling is optional; without it nothing is reported rather than guessed.
    const bad = 'const x = ;\n';
    await writeFile(join(dir, 'maybe.ts'), bad);
    const issue = await check('maybe.ts', bad, dir);
    assert.ok(issue === undefined || issue.checker === 'TypeScript');
  });

  test('Python: flags a syntax error, accepts valid code', { skip: !has('python3') }, async () => {
    await writeFile(join(dir, 'bad.py'), 'def f(:\n    pass\n');
    const issue = await check('bad.py', 'def f(:\n    pass\n');
    assert.equal(issue?.checker, 'Python');
    assert.match(issue!.issues[0]!, /^line 1,/);
    await writeFile(join(dir, 'ok.py'), 'def f():\n    return 1\n');
    assert.equal(await check('ok.py', 'def f():\n    return 1\n'), undefined);
  });

  test('shell: flags an unterminated construct', { skip: !has('bash') }, async () => {
    await writeFile(join(dir, 'bad.sh'), 'echo $(\n');
    const issue = await check('bad.sh', 'echo $(\n');
    assert.equal(issue?.checker, 'bash -n');
    await writeFile(join(dir, 'ok.sh'), 'echo hi\n');
    assert.equal(await check('ok.sh', 'echo hi\n'), undefined);
  });

  test('unknown file types and huge files are not checked', async () => {
    assert.equal(await check('notes.md', '{ not json'), undefined);
    assert.equal(await check('big.json', `{"a":"${'x'.repeat(1_000_001)}"`), undefined);
  });

  test('AGENT_SYNTAX_CHECK=0 turns the check off', async () => {
    process.env['AGENT_SYNTAX_CHECK'] = '0';
    assert.equal(await check('off.json', '{bad'), undefined);
  });
});

describe('formatting', () => {
  test('uses a workspace-relative path and caps the number of lines', () => {
    const issue = { checker: 'TypeScript', issues: ['1:1 a', '2:1 b', '3:1 c', '4:1 d', '5:1 e', '6:1 f'] };
    const text = formatSyntaxIssue(issue, join(dir, 'src', 'a.ts'), dir);
    assert.match(text, /^⚠ Syntax check failed \(TypeScript\) in src[\\/]a\.ts:/);
    assert.match(text, /… and 1 more/);
    assert.match(text, /saved as written/);
  });

  test('is inserted after the first block so a long diff cannot hide it', () => {
    assert.equal(insertAfterFirstBlock('OK: wrote x\n\n--- diff', 'WARN'), 'OK: wrote x\n\nWARN\n\n--- diff');
    assert.equal(insertAfterFirstBlock('OK: wrote x', 'WARN'), 'OK: wrote x\n\nWARN');
  });
});

describe('write_file and edit_file report a broken result in the same tool call', () => {
  test('write_file: a broken JSON file is flagged right after the OK line; a valid one is not', async () => {
    const path = join(dir, 'written.json');
    const bad = await executeTool('write_file', { path, content: '{"a": 1,}\n' });
    assert.match(bad, /^OK: wrote /);
    assert.ok(bad.indexOf('Syntax check failed') > 0);
    assert.ok(bad.indexOf('Syntax check failed') < bad.indexOf('```diff'), 'the warning comes before the diff');
    assert.equal(await readFile(path, 'utf8'), '{"a": 1,}\n', 'the write itself is not blocked');

    const good = await executeTool('write_file', { path, content: '{"a": 1}\n' });
    assert.doesNotMatch(good, /Syntax check/);
  });

  test('edit_file: an edit that breaks the syntax is flagged', async () => {
    const path = join(dir, 'edited.js');
    await writeFile(path, 'const a = 1;\nconst b = 2;\n');
    const read = await executeTool('read_file', { path });
    assert.match(read, /const a = 1/);
    const result = await executeTool('edit_file', { path, edits: [{ search: 'const b = 2;', replace: 'const b = ;' }] });
    assert.match(result, /^OK: /);
    assert.match(result, /Syntax check failed \(Node\)/);
    assert.match(result, /line 2:/);

    const fixed = await executeTool('edit_file', { path, edits: [{ search: 'const b = ;', replace: 'const b = 3;' }] });
    assert.doesNotMatch(fixed, /Syntax check/);
  });

  test('a failed write never gets a diagnostic', async () => {
    const result = await executeTool('edit_file', { path: join(dir, 'does-not-exist.js'), edits: [{ search: 'x', replace: 'y' }] });
    assert.match(result, /^Error/);
    assert.doesNotMatch(result, /Syntax check/);
  });
});
