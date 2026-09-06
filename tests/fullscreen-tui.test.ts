import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import blessed from 'blessed';
import { AgentRuntime } from '../src/runtime/agent-runtime.js';
import { AgentRuntimeStore } from '../src/runtime/agent-store.js';
import { runFullscreenTui } from '../src/ui/fullscreen-tui.js';

test('Windows terminal negotiates mouse reporting and handles raw wheel/click input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coder-tui-'));
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void };
  input.isTTY = true;
  input.setRawMode = () => {};
  const mouse = async (button: number, x: number, y: number, release = false) => {
    input.write(`\x1b[<${button};${x + 1};${y + 1}${release ? 'm' : 'M'}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  output.columns = 80; output.rows = 24; output.isTTY = true;
  let terminalOutput = '';
  output.on('data', (chunk) => { terminalOutput += chunk.toString(); });
  output.resume();
  const original = blessed.screen;
  let screen: blessed.Widgets.Screen | undefined;
  blessed.screen = ((options: blessed.Widgets.IScreenOptions) => {
    screen = original({ ...options, input, output, terminal: 'windows-ansi' });
    return screen;
  }) as typeof blessed.screen;
  let finishGeneration!: () => void;
  const generationGate = new Promise<void>((resolve) => { finishGeneration = resolve; });
  const runtime = new AgentRuntime({
    store: new AgentRuntimeStore(root),
    resolveModel: () => ({ type: 'ollama', baseUrl: 'http://test', model: 'test' }),
    modelStream: async function* () {
      yield { content: null, thinking: 'Inspecting the repository. ', done: false };
      yield { content: null, thinking: 'Checking the affected tests.', done: false };
      yield { content: Array.from({ length: 80 }, (_, index) => `History line ${index}`).join('\n'), done: false };
      await generationGate;
      yield { content: '\nDone', done: true };
    },
  });
  let done: Promise<void> | undefined;
  const copied: string[] = [];
  try {
    await runtime.whenReady();
    done = runFullscreenTui(runtime, {
      copyToClipboard: async (text) => { copied.push(text); },
      modelName: 'test', resolveModel: () => ({ name: 'test', config: { type: 'ollama', baseUrl: 'http://test', model: 'test' } }),
      configManager: { getConfig: () => ({}), saveConfig: async () => {} },
    });
    for (let attempt = 0; !screen && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(screen);
    screen.program.flush();
    assert.ok(terminalOutput.includes('\x1b[?1000h'), 'Windows terminals must be asked to report mouse buttons and wheel events');
    assert.ok(terminalOutput.includes('\x1b[?1006h'), 'Windows terminals must use SGR mouse coordinates');
    const logoRow = screen.lines.findIndex((row) => row.map((cell) => cell[1]).join('').includes('C O D E R'));
    const initialConversation = screen.children[1] as blessed.Widgets.BoxElement;
    assert.equal(logoRow, 11, `initial banner must be vertically centered: height=${initialConversation.height}, scrollHeight=${initialConversation.getScrollHeight()}, base=${initialConversation.childBase}`);
    const editor = screen.focused as blessed.Widgets.BoxElement;
    input.write('/');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const suggestions = screen.children.at(-1) as blessed.Widgets.ListElement;
    assert.equal(suggestions.hidden, false);
    assert.ok(suggestions.items.some((item) => item.getContent().includes('/provider')));
    input.write('mo');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(suggestions.items.length, 2);
    input.write('\t');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(editor.getContent(), '/model ');
    assert.equal(suggestions.hidden, true);
    input.write('\x15');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const chineseDraft = '修复中文输入'.repeat(8);
    editor.emit('keypress', chineseDraft, { name: undefined });
    editor.emit('keypress', '', { name: 'j', ctrl: true });
    editor.emit('keypress', 'second line', { name: undefined });
    assert.equal(editor.getContent().replace(/\x03/g, '').replace(/\n/g, ''), `${chineseDraft}second line`);
    screen.emit('key C-b', '', { full: 'C-b', name: 'b', ctrl: true });
    assert.equal(editor.left, 3);
    assert.equal(Number(editor.width), 76);
    const conversation = screen.children[1] as blessed.Widgets.BoxElement;
    assert.ok(conversation.getContent().includes('C O D E R'));
    assert.doesNotMatch(conversation.getContent(), /Welcome to Coder|Describe a change|Configure a provider|Commands and shortcuts/);
    editor.emit('keypress', '', { name: 'enter' });
    for (let attempt = 0; !conversation.getContent().includes('History line 79') && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(conversation.getContent(), /History line 79/);
    const previousTop = conversation.childBase;
    assert.ok(previousTop > 0);
    await mouse(64, 3, 5);
    assert.ok(conversation.childBase < previousTop, 'one wheel event must scroll the viewport immediately');
    const scrolledTop = conversation.childBase;
    screen.emit('resize');
    assert.equal(conversation.childBase, scrolledTop, 'refresh must preserve the visible top row');
    for (let attempt = 0; conversation.childBase > 0 && attempt < 100; attempt++) await mouse(64, 3, 5);
    assert.equal(conversation.childBase, 0);
    const visibleRows = () => screen!.lines.map((row) => row.map((cell) => cell[1]).join(''));
    assert.ok(visibleRows().some((row) => row.includes('second line')), 'old user message remains visible at the top');
    const thinkingRow = visibleRows().findIndex((row) => row.includes('Thought'));
    assert.ok(thinkingRow >= 0);
    await mouse(0, 3, thinkingRow);
    await mouse(0, 3, thinkingRow, true);
    assert.match(conversation.getContent(), /Inspecting the repository\. Checking the affected tests\./, 'thinking deltas are available inside the expanded block');
    assert.equal(conversation.childBase, 0, 'expansion must not jump to latest output');
    const traceRow = visibleRows().findIndex((row) => row.includes('Inspecting the repository.'));
    assert.ok(traceRow >= 0);
    await mouse(0, 4, traceRow);
    await mouse(32, 13, traceRow);
    await mouse(0, 13, traceRow, true);
    assert.match(conversation.getContent(), /Inspecting the repository/, 'dragging selects text without collapsing the block');
    input.write('\x03');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(copied.at(-1), 'Inspecting', 'Ctrl+C copies the selected text instead of exiting');
    assert.equal(screen.focused, editor, 'expanding keeps keyboard focus in the editor');
    input.write('next edit');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(editor.getContent(), 'next edit', 'typing immediately after expansion edits the draft');
    input.write('\x15');
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write('\x1bOQ');
    await new Promise<void>((resolve) => setImmediate(resolve));
    screen.program.flush();
    assert.ok(terminalOutput.lastIndexOf('\x1b[?1000l') > terminalOutput.lastIndexOf('\x1b[?1000h'), 'F2 releases mouse capture for native text selection');
    const renderCount = screen.renders;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(screen.renders, renderCount, 'native selection avoids unnecessary spinner redraws');
    input.write('\x1bOQ');
    await new Promise<void>((resolve) => setImmediate(resolve));
    screen.program.flush();
    assert.ok(terminalOutput.lastIndexOf('\x1b[?1000h') > terminalOutput.lastIndexOf('\x1b[?1000l'), 'F2 restores mouse interaction');
    finishGeneration();
    for (let attempt = 0; !conversation.getContent().includes('Done') && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(conversation.getContent(), /Done/);
    assert.equal(conversation.childBase, 0, 'generation completion must preserve history position');
    conversation.scroll(2, true);
    screen.render();
    assert.doesNotMatch(conversation.getContent(), /Thinking/, 'finished reasoning no longer displays the active label');
    const completedRow = visibleRows().findIndex((row) => row.includes('Thought'));
    assert.ok(completedRow >= 0);
    await mouse(0, 3, completedRow);
    await mouse(0, 3, completedRow, true);
    assert.doesNotMatch(conversation.getContent(), /Inspecting the repository/, 'clicking completed Thought collapses it after scrolling');
    await mouse(0, 3, completedRow);
    await mouse(0, 3, completedRow, true);
    assert.match(conversation.getContent(), /Inspecting the repository/, 'clicking completed Thought expands it after scrolling');
    const beforeDown = conversation.childBase;
    await mouse(65, 3, 5);
    assert.ok(conversation.childBase > beforeDown, 'raw wheel-down returns toward newer messages');
    const statusbar = screen.children[0] as blessed.Widgets.BoxElement;
    assert.equal(statusbar.top, 23, 'status is below the editor on the last screen row');
    assert.equal(conversation.top, 0);
    assert.equal(editor.getContent(), '');
  } finally {
    finishGeneration();
    screen?.emit('key C-c', '', { full: 'C-c', name: 'c', ctrl: true });
    await done;
    assert.ok(terminalOutput.includes('\x1b[?1000l'), 'exit restores normal terminal mouse behavior');
    blessed.screen = original;
    await runtime.shutdown();
    input.destroy(); output.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
