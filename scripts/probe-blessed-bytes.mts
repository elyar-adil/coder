// Byte-level probe: drive a real blessed screen over a PassThrough and count
// terminal output bytes + changed cells per frame, matrix vs aurora.
// Usage: node --import tsx/esm scripts/probe-blessed-bytes.mjs
import blessed from 'blessed';
import { PassThrough } from 'node:stream';
import { setActiveTheme } from '../src/ui/theme.js';
import { renderWelcome, INTRO_DURATION } from '../src/ui/welcome.js';

const W = 75, H = 20;
const input = new PassThrough();
input.isTTY = true;
input.setRawMode = () => {};
const output = new PassThrough();
output.columns = 80;
output.rows = 24;
output.isTTY = true;
output.resume();

let bytes = 0;
const origWrite = output.write.bind(output);
output.write = (chunk, ...rest) => {
  if (chunk && chunk.length) bytes += chunk.length;
  return origWrite(chunk, ...rest);
};

const screen = blessed.screen({ input, output, terminal: 'windows-ansi', smartCSR: true, fullUnicode: true });
const box = blessed.box({ parent: screen, width: 80, height: 24, top: 0, left: 0, style: { bg: 'black' }, tags: true });
screen.render(); // initial paint

function frame(f: number): string {
  return renderWelcome(W, H, 24, f).join('\n') + '\n\n\n\n';
}

function run(name: string, theme: string, frames: number): void {
  setActiveTheme(theme);
  bytes = 0;
  const perFrame: number[] = [];
  for (let f = 0; f < frames; f++) {
    const before = bytes;
    box.setContent(frame(f));
    screen.render();
    screen.program.flush(); // _buffer defers via nextTick; force it now
    perFrame.push(bytes - before);
  }
  const loop = perFrame.slice(INTRO_DURATION + 5);
  const sum = loop.reduce((a, b) => a + b, 0);
  const avg = sum / loop.length;
  console.log(`${name}: loopAvg=${avg.toFixed(0)}B/frame loopMax=${Math.max(...loop)}B → ${(avg * 20 / 1024).toFixed(1)}KB/s at 20fps`);
}

run('matrix (current code)', 'matrix', 200);
run('aurora', 'aurora', 200);

// Changed-cell churn: diff blessed's own cell buffers between frames.
setActiveTheme('matrix');
function cellChurn(frames: number): void {
  type Snapshot = { attr: number; ch: string }[][];
  let prev: Snapshot | null = null;
  const churns: [number, number][] = [];
  let maxRows = 0;
  for (let f = 0; f < frames; f++) {
    box.setContent(frame(f));
    screen.render();
    const lines = screen.lines as unknown as [number, string][][];
    let cells = 0;
    const rows = new Set<number>();
    for (let y = 0; y < H; y++) {
      const line = lines[y] as unknown as [number, string][] & { dirty?: boolean };
      const oline = prev?.[y];
      if (!line || !oline) continue;
      for (let x = 0; x < W; x++) {
        if (line[x][0] !== oline[x][0] || line[x][1] !== oline[x][1]) {
          cells++;
          rows.add(y);
        }
      }
    }
    prev = lines.slice(0, H).map((l) => l.slice(0, W).map((c) => [c[0], c[1]])) as unknown as Snapshot;
    if (f > INTRO_DURATION + 5) {
      churns.push([cells, rows.size]);
      maxRows = Math.max(maxRows, rows.size);
    }
  }
  const avgCells = churns.reduce((a, c) => a + c[0], 0) / churns.length;
  const avgRows = churns.reduce((a, c) => a + c[1], 0) / churns.length;
  console.log(`churn(matrix): avgCells=${avgCells.toFixed(0)} avgRows=${avgRows.toFixed(1)} maxRows=${maxRows} (screen is ${W}x${H})`);
}
cellChurn(120);

// DEC 2026 bracket ordering: drive syncRender-equivalent through a real screen
// and assert every flush chunk is 2026h ... frame bytes ... 2026l.
function syncBracketCheck(rounds: number): void {
  const SYNC_BEGIN = '\x1b[?2026h';
  const SYNC_END = '\x1b[?2026l';
  const chunks: string[] = [];
  const origWrite = output.write.bind(output);
  output.write = (chunk: any, ...rest: any[]) => {
    if (typeof chunk === 'string' && chunk.length) chunks.push(chunk);
    return origWrite(chunk, ...rest);
  };
  try {
    for (let i = 0; i < rounds; i++) {
      // Same sequence as fullscreen-tui renderScreen/syncRender.
      screen.program._write(SYNC_BEGIN);
      screen.render();
      screen.program._write(SYNC_END);
      screen.program.flush();
    }
  } finally {
    output.write = origWrite;
  }
  // An empty bracket (h+l, 16B) is a legitimate no-op frame. The real defect
  // class is frame bytes escaping the bracket, or END before BEGIN.
  let begin = 0, end = 0, escaped = 0, endBeforeBegin = 0;
  for (const chunk of chunks) {
    for (let idx = chunk.indexOf(SYNC_BEGIN); idx !== -1; idx = chunk.indexOf(SYNC_BEGIN, idx + 1)) begin++;
    for (let idx = chunk.indexOf(SYNC_END); idx !== -1; idx = chunk.indexOf(SYNC_END, idx + 1)) end++;
    let pos = 0;
    while (true) {
      const h = chunk.indexOf(SYNC_BEGIN, pos);
      if (h === -1) break;
      const l = chunk.indexOf(SYNC_END, h);
      if (l === -1) {
        // Unterminated bracket: everything after h is in-flight frame bytes
        // that never got closed — count as escaped tail.
        escaped += chunk.length - h - SYNC_BEGIN.length;
        pos = chunk.length;
      } else {
        // Bytes between BEGIN and END are the frame: none may contain an
        // out-of-place marker. Bytes after END before the next BEGIN would
        // be escaped — detect via a scan below.
        pos = l + SYNC_END.length;
        const nextH = chunk.indexOf(SYNC_BEGIN, pos);
        const tail = nextH === -1 ? chunk.length - pos : nextH - pos;
        if (tail > 0) escaped += tail;
      }
    }
    const firstH = chunk.indexOf(SYNC_BEGIN);
    if (firstH > 0) {
      // Bytes before the first BEGIN: acceptable only if they are the tail of
      // a previous frame's flush (chunk 0 prelude) — flag anything else.
      if (chunks.indexOf(chunk) !== 0) endBeforeBegin += firstH;
    }
  }
  console.log(`syncBracket: rounds=${rounds} chunks=${chunks.length} begin=${begin} end=${end} escapedBytes=${escaped} endBeforeBegin=${endBeforeBegin}`);
  const ok = begin === rounds && end === rounds && escaped === 0 && endBeforeBegin === 0;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — no frame bytes escape the 2026h…2026l brackets`);
}
syncBracketCheck(60);

screen.destroy();
