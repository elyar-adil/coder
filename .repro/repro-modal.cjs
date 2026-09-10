// Minimal reproduction of the ask() modal input path:
// enableBracketedPaste(process.stdin) -> blessed.screen -> blessed.textbox.readInput()
const { PassThrough } = require('node:stream');
const blessed = require('/Users/elyar.adil/coder/node_modules/blessed');
const { enableBracketedPaste } = require('/Users/elyar.adil/coder/dist/ui/bracketed-paste.js');

const raw = new PassThrough();
raw.isTTY = true;
raw.setRawMode = () => {};
const input = enableBracketedPaste(raw);

const output = new PassThrough();
output.isTTY = true;
output.columns = 120;
output.rows = 40;
output.write = () => true;

const screen = blessed.screen({
  input, output, terminal: 'xterm-256color',
  smartCSR: true, fullUnicode: true,
});
screen.program.decset('1004');

// Mirror ask(): a centered box with a textbox child.
const modal = blessed.box({ parent: screen, top: 'center', left: 'center', width: 50, height: 7 });
const inputBox = blessed.textbox({
  parent: modal, top: 3, left: 1, right: 1, height: 1,
  inputOnFocus: true, keys: true, mouse: true, censor: true,
});
let done = false;
inputBox.on('submit', (v) => { if (!done) { done = true; console.log('>>> SUBMIT value=' + JSON.stringify(String(v)) + ' focused=' + (screen.focused ? screen.focused.type : 'none')); } });
inputBox.on('cancel', () => { if (!done) { done = true; console.log('>>> CANCEL focused=' + (screen.focused ? screen.focused.type : 'none')); } });
inputBox.focus();
inputBox.readInput();
screen.render();

const feed = (label, bytes, waitMs = 80) => new Promise((resolve) => {
  raw.write(bytes);
  setTimeout(() => {
    console.log('[' + label + '] value=' + JSON.stringify(inputBox.value) + ' done=' + done);
    resolve();
  }, waitMs);
});

(async () => {
  await feed('focus-in ESC[I', '\x1b[I');
  await feed('click press+release', '\x1b[<0;12;5M\x1b[<0;12;5m');
  await feed('paste no-newline', '\x1b[200~sk-proj-abc123\x1b[201~');
  if (!done) { inputBox.setValue(''); done = false; inputBox._reading = false; inputBox.readInput(); }
  await feed('paste with CRLF', '\x1b[200~sk-abc\r\nxyz\x1b[201~');
  if (!done) { inputBox._reading = false; inputBox.readInput(); }
  await feed('plain paste CRLF', 'sk-abc\r\nxyz');
  if (!done) { inputBox._reading = false; inputBox.readInput(); }
  await feed('focus-out ESC[O', '\x1b[O');
  await feed('focus-in again', '\x1b[I');
  console.log('final value=' + JSON.stringify(inputBox.value) + ' done=' + done);
  process.exit(0);
})();
