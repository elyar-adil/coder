// Fresh screen per scenario — no state juggling.
const { PassThrough } = require('node:stream');
const blessed = require('/Users/elyar.adil/coder/node_modules/blessed');
const { enableBracketedPaste } = require('/Users/elyar.adil/coder/dist/ui/bracketed-paste.js');

function scenario(name, script) {
  return new Promise((resolve) => {
    const raw = new PassThrough(); raw.isTTY = true; raw.setRawMode = () => {};
    const input = enableBracketedPaste(raw);
    const output = new PassThrough(); output.isTTY = true; output.columns = 120; output.rows = 40; output.write = () => true;
    const screen = blessed.screen({ input, output, terminal: 'xterm-256color', smartCSR: true, fullUnicode: true });
    screen.program.decset('1004');
    const composer = blessed.box({ parent: screen, bottom: 0, width: '100%', height: 2, input: true, keys: true, mouse: true });
    const modal = blessed.box({ parent: screen, top: 'center', left: 'center', width: 50, height: 7 });
    const box = blessed.textbox({ parent: modal, top: 3, left: 1, right: 1, height: 1, inputOnFocus: true, keys: true, mouse: true, censor: true });
    const events = [];
    box.on('submit', (v) => events.push('SUBMIT:' + JSON.stringify(String(v))));
    box.on('cancel', () => events.push('CANCEL'));
    box.focus();
    box.readInput();
    screen.render();
    let i = 0;
    const step = () => {
      if (i >= script.length) {
        console.log('[' + name + '] value=' + JSON.stringify(box.value) + ' events=' + (events.join(',') || 'none') + ' focused=' + (screen.focused ? screen.focused.type : 'none'));
        screen.destroy(); resolve(); return;
      }
      const [delay, bytes] = script[i++];
      raw.write(bytes);
      setTimeout(step, delay);
    };
    setTimeout(step, 60);
  });
}

const WAIT = 120;
(async () => {
  await scenario('A: focus in/out only', [[WAIT, '\x1b[I'], [WAIT, '\x1b[O'], [WAIT, '\x1b[I']]);
  await scenario('B: bracketed paste, no newline', [[WAIT, '\x1b[200~sk-proj-abc123\x1b[201~']]);
  await scenario('C: bracketed paste WITH CRLF', [[WAIT, '\x1b[200~sk-abc\r\nxyz\x1b[201~']]);
  await scenario('D: bracketed paste with LF only', [[WAIT, '\x1b[200~line1\nline2\x1b[201~']]);
  await scenario('E: click on composer pane (focus steal)', [[WAIT, '\x1b[<0;20;38M'], [WAIT, '\x1b[<0;20;38m']]);
  await scenario('F: click on modal itself', [[WAIT, '\x1b[<0;40;20M'], [WAIT, '\x1b[<0;40;20m']]);
  process.exit(0);
})();
