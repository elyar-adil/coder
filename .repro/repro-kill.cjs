// Real-app wiring: composer.on('click', focusComposer) + conversation.on('click', focusConversation),
// where focusComposer() unconditionally composer.focus().
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
    // Real-app geometry: conversation top:0..bottom:3, composer bottom:1 height:2
    const conversation = blessed.box({ parent: screen, top: 0, left: 0, width: '100%', bottom: 3, mouse: true, keys: true, vi: true, autoFocus: false });
    const composer = blessed.box({ parent: screen, bottom: 1, left: 3, width: '100%-4', height: 2, input: true, keys: true, mouse: true });
    // The ask() modal: NOTE — the box itself has NO mouse/clickable option, only the 1-row textbox has mouse:true
    const modal = blessed.box({ parent: screen, top: 'center', left: 'center', width: 50, height: 7 });
    const inputBox = blessed.textbox({ parent: modal, top: 3, left: 1, right: 1, height: 1, inputOnFocus: true, keys: true, mouse: true, censor: true });

    // focusComposer() from the real app:
    const focusComposer = () => { composer.focus(); };
    const focusConversation = () => { focusComposer(); };
    composer.on('click', focusComposer);
    conversation.on('click', focusConversation);
    conversation.on('mousedown', focusConversation);

    const events = [];
    inputBox.on('submit', (v) => events.push('SUBMIT:' + JSON.stringify(String(v))));
    inputBox.on('cancel', () => events.push('CANCEL'));
    inputBox.focus();
    inputBox.readInput();
    screen.render();
    let i = 0;
    const step = () => {
      if (i >= script.length) {
        console.log('[' + name + '] events=' + (events.join(',') || 'none') + ' modalAlive=' + !modal.destroyed + ' focused=' + (screen.focused ? screen.focused.type : 'none'));
        screen.destroy(); resolve(); return;
      }
      const [delay, bytes] = script[i++];
      raw.write(bytes);
      setTimeout(step, delay);
    };
    setTimeout(step, 60);
  });
}

const WAIT = 150;
(async () => {
  // User returns from browser, clicks into the popup's TITLE row (above the 1-row input)
  await scenario('G: click modal title row (falls through?)', [[WAIT, '\x1b[<0;60;16M'], [WAIT, '\x1b[<0;60;16m']]);
  // Click on the modal hint row (bottom row of modal)
  await scenario('H: click modal hint row', [[WAIT, '\x1b[<0;60;23M'], [WAIT, '\x1b[<0;60;23m']]);
  // Click on the 1-row input itself
  await scenario('I: click the input row', [[WAIT, '\x1b[<0;40;20M'], [WAIT, '\x1b[<0;40;20m']]);
  // Click the conversation area behind the modal
  await scenario('J: click conversation area', [[WAIT, '\x1b[<0;10;10M'], [WAIT, '\x1b[<0;10;10m']]);
  // Wheel scroll over conversation
  await scenario('K: wheel up over conversation', [[WAIT, '\x1b[<64;10;10M']]);
  // Focus events alone
  await scenario('L: focus in/out only', [[WAIT, '\x1b[I'], [WAIT, '\x1b[O'], [WAIT, '\x1b[I']]);
  process.exit(0);
})();
