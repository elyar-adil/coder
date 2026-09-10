// Raw chunk dump for the DEC 2026 syncRender sequence — no aggregate
// heuristics, just what the terminal actually receives per frame.
import blessed from 'blessed';
import { PassThrough } from 'node:stream';

const input = new PassThrough();
input.isTTY = true;
input.setRawMode = () => {};
const output = new PassThrough();
output.columns = 80;
output.rows = 24;
output.isTTY = true;
output.resume();

const screen = blessed.screen({ input, output, terminal: 'windows-ansi', smartCSR: true, fullUnicode: true });
const box = blessed.box({ parent: screen, width: 80, height: 24, top: 0, left: 0, style: { bg: 'black' }, tags: true });
screen.render();
screen.program.flush();
output.read(); // drain

const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
const chunks: string[] = [];
const origWrite = output.write.bind(output);
output.write = (chunk: any, ...rest: any[]) => {
  if (typeof chunk === 'string' && chunk.length) chunks.push(chunk);
  return origWrite(chunk, ...rest);
};

const dump = (label: string, fn: () => void): void => {
  chunks.length = 0;
  fn();
  console.log(`\n=== ${label} ===`);
  if (chunks.length === 0) {
    console.log('  (no output)');
  } else {
    for (const c of chunks) {
      const inner = c.slice(SYNC_BEGIN.length, c.length - SYNC_END.length);
      const hasH = c.startsWith(SYNC_BEGIN);
      const hasL = c.endsWith(SYNC_END);
      console.log(`  chunk len=${c.length} h@0=${hasH} l@last=${hasL} inner=${JSON.stringify(inner.slice(0, 100))}${inner.length > 100 ? '…' : ''}`);
    }
  }
};

let f = 0;
const frame = (): void => {
  box.setContent('frame ' + (f++));
  screen.render();
};
const bracketed = (): void => {
  screen.program._write(SYNC_BEGIN);
  screen.render();
  screen.program._write(SYNC_END);
  screen.program.flush();
};

dump('frame 1 (changes)', bracketed);
dump('frame 2 (same content → no-op draw)', bracketed);
box.setContent('frame 2 altered');
dump('frame 3 (content changes again)', bracketed);
dump('frame 4 (no-op again)', bracketed);
// Full-redraw path (renderScreen with fullRedrawPending): realloc() must run
// inside the bracket (matches src/ui/fullscreen-tui.ts renderScreen), so
// program.clear()'s \x1b[2J lands inside the atomic frame too.
const bracketedRealloc = (): void => {
  screen.program._write(SYNC_BEGIN);
  screen.realloc();
  screen.render();
  screen.program._write(SYNC_END);
  screen.program.flush();
};
dump('frame 5 (realloc inside bracket)', bracketedRealloc);
output.write = origWrite;
screen.destroy();
