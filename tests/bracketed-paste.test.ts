import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { enableBracketedPaste } from '../src/ui/bracketed-paste.js';

type FakeInput = PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void };

const start = async (options?: { holdFlushMs?: number }): Promise<{
  real: FakeInput;
  proxy: ReturnType<typeof enableBracketedPaste>;
  chunks: Array<{ text: string; pasted: boolean }>;
  done: Promise<void>;
}> => {
  const real = new PassThrough() as FakeInput;
  real.isTTY = true;
  real.setRawMode = () => {};
  const proxy = enableBracketedPaste(real, options);
  const chunks: Array<{ text: string; pasted: boolean }> = [];
  proxy.on('data', (chunk: Buffer | string) => {
    chunks.push({ text: String(chunk), pasted: proxy.pasteActive });
  });
  const done = new Promise<void>((resolve) => proxy.on('close', resolve));
  // Let the lazy attach and stream plumbing settle before writing.
  await new Promise((resolve) => setImmediate(resolve));
  return { real, proxy, chunks, done };
};

test('bracketed paste arrives as one literal chunk with pasteActive', async () => {
  const { real, proxy, chunks, done } = await start();
  real.write('\x1b[200~alpha\nbravo\x1b[201~');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(chunks, [{ text: 'alpha\nbravo', pasted: true }]);
  assert.equal(proxy.pasteActive, false, 'pasteActive must be off after the paste');
  proxy.destroy();
  await done;
});

test('CRLF inside a paste is normalized to LF', async () => {
  const { real, chunks, done } = await start();
  real.write('\x1b[200~one\r\ntwo\x1b[201~');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(chunks, [{ text: 'one\ntwo', pasted: true }]);
  real.destroy();
  await done;
});

test('markers split across reads stay recognized', async () => {
  const { real, chunks, done } = await start();
  real.write('\x1b[20');
  real.write('0~ab\x1b[20');
  real.write('1~');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(chunks, [{ text: 'ab', pasted: true }]);
  real.destroy();
  await done;
});

test('an empty paste inserts nothing', async () => {
  const { real, chunks, done } = await start();
  real.write('\x1b[200~\x1b[201~');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(chunks, []);
  real.destroy();
  await done;
});

test('plain typing passes through untouched', async () => {
  const { real, chunks, done } = await start();
  real.write('hi there');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(chunks, [{ text: 'hi there', pasted: false }]);
  real.destroy();
  await done;
});

test('a lone CR stays a typed Enter and LF-only chunks are paste content', async () => {
  const { real, chunks, done } = await start();
  real.write('before');
  real.write('\r');
  real.write('\ninterior\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(chunks, [
    { text: 'before', pasted: false },
    { text: '\r', pasted: false },
    { text: '\ninterior\n', pasted: true },
  ]);
  real.destroy();
  await done;
});

test('a whole CRLF chunk acts as a typed Enter', async () => {
  const { real, chunks, done } = await start();
  real.write('\r\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(chunks, [{ text: '\n', pasted: false }]);
  real.destroy();
  await done;
});

test('a held partial marker flushes as plain text on idle', async () => {
  const { real, chunks, done } = await start({ holdFlushMs: 10 });
  real.write('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(chunks, [{ text: '\x1b', pasted: false }]);
  real.destroy();
  await done;
});

test('destroy detaches every listener from the real stream', async () => {
  const { real, proxy, done } = await start();
  proxy.destroy();
  await done;
  // Node adds bookkeeping listeners (e.g. 'prefinish') to a stream it is
  // destroying; only our forwarding listeners would leak across tests.
  assert.deepEqual(
    real.eventNames().filter((name) => name !== 'prefinish'),
    [],
  );
});
