import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_WINDOW_LINES, MAX_LINE_CHARS, MAX_READ_BYTES, formatLineWindow } from '../src/infra/text-file.js';
import { executeTool } from '../src/infra/tools.js';

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'maw-read-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

const lines = (count: number, make: (index: number) => string): string => Array.from({ length: count }, (_, index) => make(index + 1)).join('\n');
const read = (name: string, args: Record<string, unknown> = {}): Promise<string> => executeTool('read_file', { path: join(dir, name), ...args });

describe('read_file refuses what is not usefully text', () => {
  test('binary content is reported instead of decoded into mojibake', async () => {
    await writeFile(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
    const result = await read('pic.png');
    assert.match(result, /^Error: .*pic\.png looks like a binary file/);
    assert.match(result, /file, xxd, strings/);
  });

  test('a directory points at list_dir', async () => {
    await mkdir(join(dir, 'sub'), { recursive: true });
    assert.match(await read('sub'), /is a directory; use list_dir/);
  });

  test('a file over the size limit points at search_text and shell tools', async () => {
    await writeFile(join(dir, 'huge.log'), Buffer.alloc(MAX_READ_BYTES + 1, 'a'));
    const result = await read('huge.log');
    assert.match(result, /too large to read whole/);
    assert.match(result, /search_text/);
  });

  test('read_files reports a binary entry and still returns the others', async () => {
    await writeFile(join(dir, 'a.txt'), 'alpha\n');
    const result = await executeTool('read_files', { paths: [join(dir, 'a.txt'), join(dir, 'pic.png')] });
    assert.match(result, /alpha/);
    assert.match(result, /looks like a binary file/);
  });
});

describe('default reading window', () => {
  test('a small file keeps the plain numbered format with no continuation note', async () => {
    await writeFile(join(dir, 'small.txt'), 'alpha\nbeta\ngamma');
    assert.equal(await read('small.txt'), '00001|alpha\n00002|beta\n00003|gamma');
    await writeFile(join(dir, 'empty.txt'), '');
    assert.equal(await read('empty.txt'), '');
  });

  test('a long file shows the first window and says where to continue', async () => {
    await writeFile(join(dir, 'long.txt'), lines(5000, (n) => `row ${n}`));
    const result = await read('long.txt');
    assert.match(result, /^00001\|row 1\n/);
    const range = /\.\.\. \(showing lines 1-(\d+) of 5000; use offset\/limit to read more\)$/.exec(result);
    assert.ok(range, 'ends with the continuation note');
    const end = Number(range[1]);
    assert.ok(end > 1000 && end <= DEFAULT_WINDOW_LINES, `window is bounded by size or lines, got ${end}`);
    assert.ok(result.length < 21_000, `window stays under the runtime's hard cut, got ${result.length}`);
    // The note's range is exactly what the listing contains, and the next page starts right after it.
    assert.match(result, new RegExp(`\\n${String(end).padStart(5, '0')}\\|row ${end}\\n\\.\\.\\.`));
    assert.match(await read('long.txt', { offset: end + 1 }), new RegExp(`^${String(end + 1).padStart(5, '0')}\\|row ${end + 1}\\n`));
  });

  test('an explicit limit is honored beyond the default window', async () => {
    const result = await read('long.txt', { offset: 1, limit: 3000 });
    assert.match(result, /\n03000\|row 3000\n/);
    assert.match(result, /showing lines 1-3000 of 5000/);
  });

  test('wide lines end the window by size, and paging by the stated range loses no line', () => {
    const raw = lines(300, (n) => `${String(n).padStart(3, '0')} ${'x'.repeat(196)}`);
    const seen: number[] = [];
    let offset = 1;
    for (let guard = 0; guard < 50 && offset <= 300; guard += 1) {
      const text = formatLineWindow(raw, { offset });
      const rows = [...text.matchAll(/^(\d{5})\|/gm)].map((match) => Number(match[1]));
      assert.ok(rows.length > 0 && rows.length < 300, 'a window is bounded but never empty');
      assert.equal(rows[0], offset);
      seen.push(...rows);
      const range = /showing lines (\d+)-(\d+) of 300/.exec(text);
      if (!range) break;
      offset = Number(range[2]) + 1;
    }
    assert.deepEqual(seen, Array.from({ length: 300 }, (_, index) => index + 1));
  });

  test('one enormous line cannot flood the listing', async () => {
    await writeFile(join(dir, 'min.js'), `var a=1;\n${'y'.repeat(300_000)}\nvar b=2;`);
    const result = await read('min.js');
    assert.ok(result.length < MAX_LINE_CHARS + 500, `listing stays small, got ${result.length}`);
    assert.match(result, /\[\+298000 chars on this line\]/);
    assert.match(result, /^00001\|var a=1;/);
    assert.match(result, /00003\|var b=2;$/);
  });
});
