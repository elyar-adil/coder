// Does a click on a background pane kill an active ask() modal input?
const { PassThrough } = require('node:stream');
const blessed = require('/Users/elyar.adil/coder/node_modules/blessed');
const { enableBracketedPaste } = require('/Users/elyar.adil/coder/dist/ui/bracketed-paste.js');

const raw = new PassThrough(); raw.isTTY = true; raw.setRawMode = () => {};
const input = enableBracketedPaste(raw);
const output = new PassThrough(); output.isTTY = true; output.columns = 120; output.rows = 40; output.write = () => true;

const screen = blessed.screen({ input, output, terminal: 'xterm-256color', smartCSR: true, fullUnicode: true });
screen.program.decset('1004');

const conversation = blessed.box({ parent: screen, top: 0, left: 0, width: '100%', height: 30, mouse: true, keys: true, vi: true, autoFocus: false });
const composer = blessed.box({ parent: screen, bottom: 0, left: 0, width: '100%', height: 2, input: true, keys: true, mouse: true });

const modal = blessed.box({ parent: screen, top: 'center', left: 'center', width: 50, height: 7 });
const inputBox = blessed.textbox({
  parent: modal, top: 3, left: 1, right: 1, height: 1,
  inputOnFocus: true, keys: true, mouse: true,
});
inputBox.on('cancel', () => console.log('>>> CANCEL fired (modal input closed!) focused=' + (screen.focused ? screen.focused.type : 'none')));
inputBox.on('submit', (v) => console.log('>>> SUBMIT value=' + JSON.stringify(String(v))));
inputBox.focus();
inputBox.readInput();
composer.focus();
console.log('setup: focused=' + (screen.focused ? screen.focused.type : 'none'));
composer.focus(); inputBox.focus();
screen.render();

// User clicks inside the conversation pane (background), coordinates over that pane
const click = (label, bytes) => new Promise((res) => { raw.write(bytes); setTimeout(res, 120); });
(async () => {
  await click('click conversation', '\x1b[<0;20;10M\x1b[<0;20;10m');
  console.log('after click: focused=' + (screen.focused ? screen.focused.type : 'none') + ' reading=' + !!inputBox._reading + ' grabKeys=' + screen.grabKeys);
  await click('click composer', '\x1b[<0;20;38M\x1b[<0;20;38m');
  console.log('after composer click: focused=' + (screen.focused ? screen.focused.type : 'none') + ' reading=' + !!inputBox._reading + ' grabKeys=' + screen.grabKeys);
  process.exit(0);
})();
