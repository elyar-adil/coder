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
import type { AgentConfig } from '../src/config.js';

type TestStream = Generator<{ content: string | null; thinking?: string; done: boolean }> | AsyncGenerator<{ content: string | null; thinking?: string; done: boolean }>;

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function startTui(options: {
  modelStream: () => TestStream;
  config?: AgentConfig;
}): Promise<{
  screen: blessed.Widgets.Screen;
  input: PassThrough & { isTTY: boolean; setRawMode: () => void };
  savedConfigs: AgentConfig[];
  finish: () => void;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'coder-tui-'));
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void };
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  output.columns = 80; output.rows = 24; output.isTTY = true;
  output.resume();
  const original = blessed.screen;
  let screen: blessed.Widgets.Screen | undefined;
  blessed.screen = ((screenOptions: blessed.Widgets.IScreenOptions) => {
    screen = original({ ...screenOptions, input, output, terminal: 'windows-ansi' });
    return screen;
  }) as typeof blessed.screen;
  const runtime = new AgentRuntime({
    store: new AgentRuntimeStore(root),
    resolveModel: () => ({ type: 'ollama', baseUrl: 'http://test', model: 'test' }),
    modelStream: options.modelStream,
  });
  let config = options.config ?? {};
  const savedConfigs: AgentConfig[] = [];
  let done: Promise<void> | undefined;
  try {
    await runtime.whenReady();
    done = runFullscreenTui(runtime, {
      modelName: 'test',
      resolveModel: () => ({ name: 'test', config: { type: 'ollama', baseUrl: 'http://test', model: 'test' } }),
      configManager: { getConfig: () => config, saveConfig: async (next) => { savedConfigs.push(next); config = next; } },
    });
    for (let attempt = 0; !screen && attempt < 100; attempt++) await wait(10);
    assert.ok(screen);
    const lockedScreen = screen;
    return {
      screen: lockedScreen,
      input,
      savedConfigs,
      finish: () => lockedScreen.emit('key C-c', '', { full: 'C-c', name: 'c', ctrl: true }),
      cleanup: async () => {
        lockedScreen.emit('key C-c', '', { full: 'C-c', name: 'c', ctrl: true });
        blessed.screen = original;
        await runtime.shutdown();
        input.destroy(); output.destroy();
        await rm(root, { recursive: true, force: true });
        await done;
      },
    };
  } catch (error) {
    blessed.screen = original;
    await runtime.shutdown();
    input.destroy(); output.destroy();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

const plainText = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, '');

test('a finished Thought freezes its duration instead of counting while the turn continues', async () => {
  let finishGeneration!: () => void;
  const generationGate = new Promise<void>((resolve) => { finishGeneration = resolve; });
  const tui = await startTui({
    modelStream: async function* () {
      yield { content: null, thinking: 'Inspecting the repository. ', done: false };
      yield { content: 'Working on it.', done: false };
      await generationGate;
      yield { content: ' Done', done: true };
    },
  });
  try {
    const { screen, input } = tui;
    const editor = screen.focused as blessed.Widgets.BoxElement;
    input.write('hi');
    await tick();
    editor.emit('keypress', '', { name: 'enter' });
    const conversation = screen.children[1] as blessed.Widgets.BoxElement;
    for (let attempt = 0; !plainText(conversation.getContent()).includes('Thought') && attempt < 100; attempt++) await wait(10);
    const firstDuration = plainText(conversation.getContent()).match(/Thought\s+(\d+s|\d+m\s+\d+s)/)?.[1];
    assert.ok(firstDuration, `completed Thought must display its duration, got: ${JSON.stringify(plainText(conversation.getContent()).split('\n').filter((line) => line.includes('Thought')))}`);
    // Two spinner ticks force re-renders; the frozen duration must not grow.
    await wait(1700);
    const secondDuration = plainText(conversation.getContent()).match(/Thought\s+(\d+s|\d+m\s+\d+s)/)?.[1];
    assert.equal(secondDuration, firstDuration, 'Thought duration must freeze when reasoning completes');
    finishGeneration();
    for (let attempt = 0; !plainText(conversation.getContent()).includes('Done') && attempt < 100; attempt++) await wait(10);
  } finally {
    finishGeneration();
    await tui.cleanup();
  }
});

test('streamed tokens render incrementally while the turn is still running', async () => {
  let finishGeneration!: () => void;
  const generationGate = new Promise<void>((resolve) => { finishGeneration = resolve; });
  const tui = await startTui({
    modelStream: async function* () {
      yield { content: 'Hel', thinking: null, done: false };
      await generationGate;
      yield { content: 'lo', done: true };
    },
  });
  try {
    const { screen, input } = tui;
    const editor = screen.focused as blessed.Widgets.BoxElement;
    input.write('hi');
    await tick();
    editor.emit('keypress', '', { name: 'enter' });
    const conversation = screen.children[1] as blessed.Widgets.BoxElement;
    // The turn is held open by the gate: 'Hel' must already be visible.
    let sawPartial = false;
    for (let attempt = 0; attempt < 50 && !sawPartial; attempt++) {
      await wait(10);
      sawPartial = plainText(conversation.getContent()).includes('Hel');
    }
    assert.ok(sawPartial, `partial token 'Hel' must render before the turn completes, got: ${JSON.stringify(plainText(conversation.getContent()))}`);
    finishGeneration();
    for (let attempt = 0; !plainText(conversation.getContent()).includes('Hello') && attempt < 100; attempt++) await wait(10);
  } finally {
    finishGeneration();
    await tui.cleanup();
  }
});

test('the waiting ellipsis shows before the first token and disappears once tokens stream', async () => {
  let firstToken!: () => void;
  let finishGeneration!: () => void;
  const firstTokenGate = new Promise<void>((resolve) => { firstToken = resolve; });
  const generationGate = new Promise<void>((resolve) => { finishGeneration = resolve; });
  const tui = await startTui({
    modelStream: async function* () {
      await firstTokenGate;
      yield { content: 'Hel', thinking: null, done: false };
      await generationGate;
      yield { content: 'lo', done: true };
    },
  });
  try {
    const { screen, input } = tui;
    const editor = screen.focused as blessed.Widgets.BoxElement;
    input.write('hi');
    await tick();
    editor.emit('keypress', '', { name: 'enter' });
    const conversation = screen.children[1] as blessed.Widgets.BoxElement;
    // Before the first token the assistant slot shows the animated ellipsis.
    let sawIndicator = false;
    for (let attempt = 0; attempt < 50 && !sawIndicator; attempt++) {
      await wait(10);
      sawIndicator = plainText(conversation.getContent()).includes('...');
    }
    assert.ok(sawIndicator, `waiting ellipsis must show before the first token, got: ${JSON.stringify(plainText(conversation.getContent()))}`);
    assert.ok(/\x1b\[9[0-6]m\.\.\./.test(conversation.getContent()), `indicator dots must be colorized, got: ${JSON.stringify(conversation.getContent())}`);
    firstToken();
    let midContent = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      await wait(10);
      midContent = plainText(conversation.getContent());
      if (midContent.includes('Hel') && !midContent.includes('...')) break;
    }
    assert.ok(midContent.includes('Hel'), `partial token must render mid-turn, got: ${JSON.stringify(midContent)}`);
    assert.ok(!midContent.includes('...'), `indicator must disappear once tokens stream, got: ${JSON.stringify(midContent)}`);
    finishGeneration();
    for (let attempt = 0; !plainText(conversation.getContent()).includes('Hello') && attempt < 100; attempt++) await wait(10);
  } finally {
    firstToken();
    finishGeneration();
    await tui.cleanup();
  }
});

test('the /theme command repaints every surface with the chosen palette and persists it', async () => {
  const tui = await startTui({
    modelStream: async function* () { yield { content: 'ok', done: true }; },
    config: { theme: 'midnight' },
  });
  try {
    const { screen, input, savedConfigs } = tui;
    const activity = screen.children.find((child) => child.type === 'list' && child.style.bg === '#11161c') as blessed.Widgets.ListElement;
    assert.equal(activity.style.bg, '#11161c', 'test setup must start on the midnight theme');
    const editor = screen.focused as blessed.Widgets.BoxElement;
    input.write('/theme');
    await tick();
    const suggestions = screen.children.at(-1) as blessed.Widgets.ListElement;
    assert.ok(suggestions.items.some((item) => item.getContent().includes('/theme')));
    input.write('\t');
    await tick();
    editor.emit('keypress', '', { name: 'enter' });
    let themeList: blessed.Widgets.ListElement | undefined;
    for (let attempt = 0; !themeList && attempt < 100; attempt++) {
      await wait(10);
      for (const child of screen.children) {
        const nested = (child as blessed.Widgets.BoxElement).children?.find((grandchild) => grandchild.type === 'list') as blessed.Widgets.ListElement | undefined;
        if (nested?.items?.some((item) => item.getContent().includes('midnight'))) themeList = nested;
      }
    }
    assert.ok(themeList, 'choosing /theme must open the theme picker');
    themeList.emit('keypress', '', { name: 'down' });
    await tick();
    themeList.emit('keypress', '', { name: 'enter' });
    for (let attempt = 0; activity.style.bg !== '#333b47' && attempt < 100; attempt++) await wait(10);
    assert.equal(activity.style.bg, '#333b47', 'activity surface must adopt the nord palette');
    const composer = screen.children.find((child) => child.style.bg === '#3b4252');
    assert.ok(composer, 'composer surface must adopt the nord palette');
    const composerBand = screen.children.find((child) => child.style.bg === '#3b4252' && Number(child.height) === 1);
    assert.ok(composerBand, 'the row above the editor must use the same full-width composer background');
    assert.equal(composerBand?.left, 0, 'composer background band must reach the left edge');
    assert.equal(savedConfigs.at(-1)?.theme, 'nord', 'theme choice must persist to config');
  } finally {
    await tui.cleanup();
  }
});

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
    let structuralRedraws = 0;
    const originalRealloc = screen.realloc.bind(screen);
    screen.realloc = () => { structuralRedraws++; originalRealloc(); };
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
    const activity = screen.children.find((child) => child.type === 'list' && child.style.bg === '#11161c') as blessed.Widgets.ListElement;
    const prompt = screen.children.find((child) => child.getContent() === '›') as blessed.Widgets.BoxElement;
    assert.equal(editor.style.bg, '#171c23');
    assert.equal(prompt.style.bg, editor.style.bg, 'prompt and editor paint one continuous input surface');
    assert.equal(activity.style.bg, '#11161c', 'activity uses a distinct surface color');
    assert.ok(structuralRedraws > 0, 'opening a structural pane must clear stale terminal cells');
    const conversation = screen.children[1] as blessed.Widgets.BoxElement;
    assert.ok(conversation.getContent().includes('C O D E R'));
    await mouse(0, 79 - 2, 3);
    await mouse(0, 79 - 2, 3, true);
    assert.ok(screen.lines.some((row) => row.map((cell) => cell[1]).join('').includes('main progress')), 'clicking an activity row opens its progress');
    input.write('\x1b');
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Dynamic modal rules must be parsed by Blessed rather than displayed as
    // literal style tags.
    screen.emit('key C-k', '', { full: 'C-k', name: 'k', ctrl: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.doesNotMatch(screen.lines.map((row) => row.map((cell) => cell[1]).join('')).join('\n'), /\{gray-fg\}|\{\/gray-fg\}/);
    input.write('\x1b');
    await new Promise<void>((resolve) => setImmediate(resolve));
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
