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
      // Ctrl+C now quits only on a second press within 2s; emit twice so the
      // arm + quit land even when another handler consumed an earlier press.
      finish: () => {
        lockedScreen.emit('key C-c', '', { full: 'C-c', name: 'c', ctrl: true });
        lockedScreen.emit('key C-c', '', { full: 'C-c', name: 'c', ctrl: true });
      },
      cleanup: async () => {
        lockedScreen.emit('key C-c', '', { full: 'C-c', name: 'c', ctrl: true });
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

test('a pinned Thought header keeps its elapsed seconds ticking while the turn runs', async () => {
  let releaseThinking!: () => void;
  const thinkingGate = new Promise<void>((resolve) => { releaseThinking = resolve; });
  const tui = await startTui({
    modelStream: async function* () {
      // A long thinking body keeps the block expanded-view taller than the
      // viewport so the header can actually be pinned by scrolling.
      yield { content: null, thinking: Array.from({ length: 60 }, (_, index) => `Reasoning paragraph line ${index}`).join('\n'), done: false };
      await thinkingGate;
      yield { content: 'Answer text.', done: true };
    },
  });
  try {
    const { screen, input } = tui;
    const editor = screen.focused as blessed.Widgets.BoxElement;
    const conversation = screen.children[1] as blessed.Widgets.BoxElement;
    const mouse = async (button: number, x: number, y: number, release = false): Promise<void> => {
      input.write(`\x1b[<${button};${x + 1};${y + 1}${release ? 'm' : 'M'}`);
      await tick();
    };
    const visibleRows = () => screen.lines.map((row) => row.map((cell) => cell[1]).join(''));
    input.write('hi');
    await tick();
    editor.emit('keypress', '', { name: 'enter' });
    for (let attempt = 0; !plainText(conversation.getContent()).includes('Reasoning paragraph line 59') && attempt < 100; attempt++) await wait(10);
    // The thinking header sits at the very top of the transcript; expand it.
    const thinkingRow = visibleRows().findIndex((row) => row.includes('Thinking'));
    assert.ok(thinkingRow >= 0, 'the active Thinking header must render before it can be expanded');
    await mouse(0, 3, thinkingRow);
    await mouse(0, 3, thinkingRow, true);
    // Scroll until the block header is pinned at the conversation top.
    const pinnedRow = (): string | undefined => visibleRows()[0].includes('▼') ? visibleRows()[0] : undefined;
    for (let attempt = 0; attempt < 60 && !pinnedRow(); attempt++) await mouse(65, 3, 5);
    const pinned = pinnedRow();
    assert.ok(pinned, 'the active block header must pin at the conversation top');
    const firstSeconds = pinned.match(/(\d+)s/)?.[1];
    assert.ok(firstSeconds, `the pinned row must show elapsed seconds, got: ${JSON.stringify(pinned)}`);
    // Wait for real time to advance past the next second boundary, then let
    // spinner ticks repaint: the pinned row must show the larger value.
    await wait(1300);
    await mouse(65, 3, 5);
    await wait(300);
    const laterSeconds = visibleRows()[0].match(/(\d+)s/)?.[1];
    assert.ok(laterSeconds, `the pinned row must still be present, got rows: ${JSON.stringify(visibleRows()[0])}`);
    assert.ok(Number(laterSeconds) > Number(firstSeconds), `pinned seconds must tick (${firstSeconds} -> ${laterSeconds})`);
    releaseThinking();
  } finally {
    releaseThinking();
    await tui.cleanup();
  }
});

test('a pinned header survives wrapped long lines and never pins a collapsed block', async () => {
  const turns = [
    // One single long line: blessed wraps it into many rendered rows, which
    // makes logical content rows diverge from rendered rows inside the block.
    { thinking: 'Long reasoning words '.repeat(150), content: 'First answer.' },
    { thinking: 'Brief second thought.', content: 'Second answer.' },
  ];
  let call = 0;
  const tui = await startTui({
    modelStream: async function* () {
      const turn = turns[call++]!;
      yield { content: null, thinking: turn.thinking, done: false };
      yield { content: turn.content, done: true };
    },
  });
  try {
    const { screen, input } = tui;
    const editor = screen.focused as blessed.Widgets.BoxElement;
    const conversation = screen.children[1] as blessed.Widgets.BoxElement;
    const mouse = async (button: number, x: number, y: number, release = false): Promise<void> => {
      input.write(`\x1b[<${button};${x + 1};${y + 1}${release ? 'm' : 'M'}`);
      await tick();
    };
    const visibleRows = () => screen.lines.map((row) => row.map((cell) => cell[1]).join(''));
    // Submit turns one at a time: messages queued before the previous turn
    // starts are absorbed into that same turn by the runtime, so back-to-back
    // submits would produce a single merged turn instead of two blocks.
    for (const turn of turns) {
      input.write('hi');
      await tick();
      editor.emit('keypress', '', { name: 'enter' });
      for (let attempt = 0; !plainText(conversation.getContent()).includes(turn.content) && attempt < 200; attempt++) await wait(10);
    }
    // Scroll back to the top and expand the first (long, wrapped) block.
    const findFirstThoughtRow = async (): Promise<number> => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const row = visibleRows().findIndex((row) => row.includes('Thought'));
        if (row >= 0) return row;
        await mouse(64, 3, 5);
      }
      return -1;
    };
    const thinkingRow = await findFirstThoughtRow();
    assert.ok(thinkingRow >= 0, 'the first Thought header must be reachable');
    await mouse(0, 3, thinkingRow);
    await mouse(0, 3, thinkingRow, true);
    assert.match(conversation.getContent(), /Long reasoning/, 'expansion shows the wrapped reasoning body');
    // Scroll down towards the first answer; the arrow must stay visible the
    // whole way: first as the real header, then as the pinned row across the
    // whole wrapped body, without a gap in between.
    const answerVisible = (): boolean => visibleRows().some((row) => row.includes('First answer.'));
    for (let attempt = 0; attempt < 200 && !(await answerVisible()); attempt++) {
      await mouse(65, 3, 5);
      assert.ok(
        visibleRows().some((row) => row.includes('▼')),
        `the block header or pinned row must stay visible at childBase=${conversation.childBase}`,
      );
    }
    assert.ok(await answerVisible(), 'the scenario must reach the first answer');
    // The wrapped block is the last scrollable content before the answers, so
    // the viewport may never scroll past its tail; the pinned row legitimately
    // persists at the bottom limit and must still collapse the block on click.
    for (let attempt = 0; attempt < 30; attempt++) await mouse(65, 3, 5);
    assert.ok(visibleRows()[0].includes('▼'), 'the pinned row persists while the expanded block still owns the viewport top');
    await mouse(0, 3, 0);
    await mouse(0, 3, 0, true);
    assert.doesNotMatch(conversation.getContent(), /Long reasoning/, 'clicking the pinned row collapses the wrapped block');
    for (let attempt = 0; attempt < 20; attempt++) await wait(10);
    // The collapsed second block must never get a pinned header.
    for (let attempt = 0; attempt < 200 && visibleRows().some((row) => row.includes('▶ Thought')); attempt++) await mouse(65, 3, 5);
    assert.ok(!visibleRows()[0].includes('Thought'), 'a collapsed block must not produce a pinned header');
    assert.ok(visibleRows().some((row) => row.includes('Second answer')), `the second answer must remain reachable: ${JSON.stringify(visibleRows())}`);
  } finally {
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
    assert.ok(/\x1b\[[0-9;]*m\./.test(conversation.getContent()), `indicator dots must be colorized, got: ${JSON.stringify(conversation.getContent())}`);
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

test('Escape stops a running turn and is a no-op while the session is idle', async () => {
  let finishGeneration!: () => void;
  const generationGate = new Promise<void>((resolve) => { finishGeneration = resolve; });
  const tui = await startTui({
    modelStream: async function* () {
      await generationGate;
      yield { content: 'done', done: true };
    },
  });
  try {
    const { screen, input } = tui;
    const editor = screen.focused as blessed.Widgets.BoxElement;
    const conversation = screen.children[1] as blessed.Widgets.BoxElement;
    // While idle, Escape must not surface any stop notice.
    editor.emit('keypress', '', { name: 'escape' });
    await tick();
    await wait(50);
    assert.doesNotMatch(plainText(conversation.getContent()), /Stopped\./);
    // Start a turn that never finishes on its own.
    input.write('long running task');
    await tick();
    editor.emit('keypress', '', { name: 'enter' });
    for (let attempt = 0; attempt < 100 && !(plainText(conversation.getContent()).includes('long running task')); attempt++) await wait(10);
    // Escape cancels the turn.
    editor.emit('keypress', '', { name: 'escape' });
    let stopped = false;
    for (let attempt = 0; attempt < 100 && !stopped; attempt++) {
      await wait(10);
      stopped = plainText(conversation.getContent()).includes('Stopped.');
    }
    assert.ok(stopped, `Escape during a turn must stop it, got: ${JSON.stringify(plainText(conversation.getContent()))}`);
    // The session recovers: a follow-up message completes normally.
    finishGeneration();
    input.write('second message');
    await tick();
    editor.emit('keypress', '', { name: 'enter' });
    let finished = false;
    for (let attempt = 0; attempt < 100 && !finished; attempt++) {
      await wait(10);
      finished = plainText(conversation.getContent()).includes('done');
    }
    assert.ok(finished, `the next message must still complete after Escape, got: ${JSON.stringify(plainText(conversation.getContent()))}`);
  } finally {
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
    assert.equal(activity.style.bg, '#333b47', 'browsing must live-preview the nord palette before committing');
    assert.equal(themeList.style.item?.bg, '#353c4a', 'picker rows must adopt the previewed modal palette');
    assert.equal(activity.style.item?.bg, '#333b47', 'activity rows must adopt the previewed palette');
    assert.ok(!savedConfigs.some((config) => config.theme === 'nord'), 'preview must not persist the palette');
    themeList.emit('keypress', '', { name: 'enter' });
    for (let attempt = 0; savedConfigs.at(-1)?.theme !== 'nord' && attempt < 100; attempt++) await wait(10);
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

test('the theme picker narrows live as you type and commits the filtered match', async () => {
  const tui = await startTui({
    modelStream: async function* () { yield { content: 'ok', done: true }; },
    config: { theme: 'midnight' },
  });
  try {
    const { screen, input, savedConfigs } = tui;
    const editor = screen.focused as blessed.Widgets.BoxElement;
    input.write('/theme');
    await tick();
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
    assert.equal(themeList.items.length, 19, 'the unfiltered picker must list every theme');
    // Typing goes to the filter row, not the composer: `mat` must leave only
    // the matrix theme, mapped back to its original index on Enter.
    for (const ch of ['m', 'a', 't']) themeList.emit('keypress', ch, { name: ch });
    await tick();
    assert.equal(themeList.items.length, 1, `filtering must narrow the list, items: ${themeList.items.map((item) => item.getContent())}`);
    assert.ok(themeList.items[0]!.getContent().includes('matrix'));
    // Refilter live: backspace twice (`m`), then type `oc` → only mocha.
    themeList.emit('keypress', '', { name: 'backspace' });
    themeList.emit('keypress', '', { name: 'backspace' });
    themeList.emit('keypress', 'o', { name: 'o' });
    themeList.emit('keypress', 'c', { name: 'c' });
    await tick();
    assert.equal(themeList.items.length, 1, `refiltering must track edits, items: ${themeList.items.map((item) => item.getContent())}`);
    assert.ok(themeList.items[0]!.getContent().includes('catppuccin-mocha'));
    themeList.emit('keypress', '', { name: 'escape' });
    await tick();
    assert.equal(savedConfigs.at(-1)?.theme ?? 'midnight', 'midnight', 'escape must dismiss without persisting');
  } finally {
    await tui.cleanup();
  }
});

test('dismissing the theme picker reverts to the previously selected theme without persisting', async () => {
  const tui = await startTui({
    modelStream: async function* () { yield { content: 'ok', done: true }; },
    config: { theme: 'midnight' },
  });
  try {
    const { screen, input, savedConfigs } = tui;
    const activity = screen.children.find((child) => child.type === 'list' && child.style.bg === '#11161c') as blessed.Widgets.ListElement;
    const editor = screen.focused as blessed.Widgets.BoxElement;
    input.write('/theme');
    await tick();
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
    for (let attempt = 0; activity.style.bg !== '#333b47' && attempt < 100; attempt++) await wait(10);
    assert.equal(activity.style.bg, '#333b47', 'browsing must live-preview the nord palette');
    // list.key() binds 'key escape' on the element itself, so emit that event directly.
    themeList.emit('key escape', '', { name: 'escape', full: 'escape' });
    for (let attempt = 0; activity.style.bg !== '#11161c' && attempt < 100; attempt++) await wait(10);
    assert.equal(activity.style.bg, '#11161c', 'dismissing the picker must roll back to midnight');
    assert.ok(!savedConfigs.some((config) => config.theme === 'nord'), 'a dismissed preview must not persist anything');
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
    // The splash screen is owned elsewhere; this test only needs the first
    // paint to have happened — never a specific wordmark or row.
    const initialConversation = screen.children[1] as blessed.Widgets.BoxElement;
    let bannerPainted = false;
    for (let attempt = 0; attempt < 100 && !bannerPainted; attempt++) {
      await wait(10);
      bannerPainted = plainText(initialConversation.getContent()).trim().length > 0;
    }
    assert.ok(bannerPainted, 'the conversation must paint its initial banner');
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
    const activity = screen.children.find((child) => child.type === 'list' && child.style.bg === '#0e1526') as blessed.Widgets.ListElement;
    const prompt = screen.children.find((child) => child.getContent() === '›') as blessed.Widgets.BoxElement;
    assert.equal(editor.style.bg, '#121a30');
    assert.equal(prompt.style.bg, editor.style.bg, 'prompt and editor paint one continuous input surface');
    assert.equal(activity.style.bg, '#0e1526', 'activity uses a distinct surface color');
    assert.ok(structuralRedraws > 0, 'opening a structural pane must clear stale terminal cells');
    const conversation = screen.children[1] as blessed.Widgets.BoxElement;
    assert.ok(plainText(conversation.getContent()).trim().length > 0, 'the welcome banner must remain painted');
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
    // Quit confirmation needs a second press within the 2s window.
    screen?.emit('key C-c', '', { full: 'C-c', name: 'c', ctrl: true });
    screen?.emit('key C-c', '', { full: 'C-c', name: 'c', ctrl: true });
    await done;
    assert.ok(terminalOutput.includes('\x1b[?1000l'), 'exit restores normal terminal mouse behavior');
    blessed.screen = original;
    await runtime.shutdown();
    input.destroy(); output.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test('the assistant slot switches to Thinking on the first reasoning delta, not before', async () => {
  let firstToken!: () => void;
  let releaseThinking!: () => void;
  let finishGeneration!: () => void;
  const firstTokenGate = new Promise<void>((resolve) => { firstToken = resolve; });
  const thinkingGate = new Promise<void>((resolve) => { releaseThinking = resolve; });
  const generationGate = new Promise<void>((resolve) => { finishGeneration = resolve; });
  const tui = await startTui({
    modelStream: async function* () {
      await firstTokenGate;
      yield { content: null, thinking: 'Inspecting the request. ', done: false };
      await thinkingGate;
      yield { content: 'Answer.', done: false };
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
    // Before any model output the slot must stay the ellipsis, never Thinking.
    for (let attempt = 0; attempt < 12; attempt++) {
      await wait(30);
      const idle = plainText(conversation.getContent());
      assert.doesNotMatch(idle, /Thinking/, `no Thinking before the first reasoning token: ${JSON.stringify(idle)}`);
      assert.ok(idle.includes('...'), 'the waiting ellipsis holds the assistant slot until reasoning starts');
    }
    // The moment a reasoning delta lands, the very next frame shows Thinking.
    firstToken();
    let sawThinking = false;
    for (let attempt = 0; attempt < 100 && !sawThinking; attempt++) {
      await wait(10);
      sawThinking = plainText(conversation.getContent()).includes('Thinking');
    }
    assert.ok(sawThinking, `first reasoning delta must flip the slot to Thinking, got: ${JSON.stringify(plainText(conversation.getContent()))}`);
    releaseThinking();
    finishGeneration();
    for (let attempt = 0; !plainText(conversation.getContent()).includes('Answer.') && attempt < 100; attempt++) await wait(10);
  } finally {
    firstToken();
    releaseThinking();
    finishGeneration();
    await tui.cleanup();
  }
});

test('an expanded Thought keeps a collapsible header pinned at the conversation top while its body is on screen', async () => {
  const tui = await startTui({
    modelStream: async function* () {
      yield { content: null, thinking: Array.from({ length: 60 }, (_, index) => `Reasoning paragraph line ${index}`).join('\n'), done: false };
      // A long answer is required so the viewport can actually scroll the whole
      // thinking block (header + body) past the top later in the scenario.
      yield { content: ['Answer text.', ...Array.from({ length: 120 }, (_, index) => `Answer detail line ${index}`)].join('\n'), done: true };
    },
  });
  try {
    const { screen, input } = tui;
    const editor = screen.focused as blessed.Widgets.BoxElement;
    const conversation = screen.children[1] as blessed.Widgets.BoxElement;
    const mouse = async (button: number, x: number, y: number, release = false): Promise<void> => {
      input.write(`\x1b[<${button};${x + 1};${y + 1}${release ? 'm' : 'M'}`);
      await tick();
    };
    const visibleRows = () => screen.lines.map((row) => row.map((cell) => cell[1]).join(''));
    input.write('hi');
    await tick();
    editor.emit('keypress', '', { name: 'enter' });
    for (let attempt = 0; !plainText(conversation.getContent()).includes('Thought') && attempt < 100; attempt++) await wait(10);
    // The long answer pushes the collapsed header above the viewport once
    // output-following lands at the bottom, so scroll back up to reach it.
    const findThoughtRow = async (): Promise<number> => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const row = visibleRows().findIndex((row) => row.includes('Thought'));
        if (row >= 0) return row;
        await mouse(64, 3, 5);
      }
      return -1;
    };
    const thinkingRow = await findThoughtRow();
    assert.ok(thinkingRow >= 0, 'the Thought header must render before it can be expanded');
    await mouse(0, 3, thinkingRow);
    await mouse(0, 3, thinkingRow, true);
    assert.match(conversation.getContent(), /Reasoning paragraph line 0/, 'expansion shows the reasoning body');
    // Expand the block, then scroll it so the real header leaves the viewport
    // while the body still fills the screen: the header must pin at the top.
    const headerGone = async (): Promise<boolean> => !visibleRows().slice(1).some((row) => row.includes('Reasoning paragraph line 0'));
    for (let attempt = 0; attempt < 60 && !(await headerGone()); attempt++) {
      await mouse(65, 3, 5);
    }
    assert.ok(await headerGone(), 'the scenario must scroll the block header off the top of the viewport');
    assert.ok(visibleRows()[0].includes('▼'), 'the collapsed-state arrow must stay reachable at the conversation top');
    assert.ok(visibleRows()[0].includes('Thought'), 'the pinned row must identify the block');
    // A completed block's icon doubles as the toggle glyph; rendering both
    // produced a double ▼ (or ▶) on the pinned row.
    const pinnedArrows = (visibleRows()[0].match(/[▼▶]/g) ?? []).length;
    assert.equal(pinnedArrows, 1, `the pinned row must render exactly one toggle arrow, got: ${JSON.stringify(visibleRows()[0])}`);
    // The pinned row must still collapse the block; afterwards the sticky row
    // disappears because the header row is back inside the viewport.
    await mouse(0, 3, 0);
    await mouse(0, 3, 0, true);
    assert.doesNotMatch(conversation.getContent(), /Reasoning paragraph line 0/, 'clicking the pinned row collapses the block');
    for (let attempt = 0; attempt < 20; attempt++) await wait(10);
    assert.ok(!visibleRows().some((row) => row.includes('Thought') && row.includes('▼')), 'the pinned row must vanish once the header is visible again');
    // Once the real (in-stream) header is visible again it must not double the
    // glyph either: the completed block's status icon reuses the toggle shape.
    const realHeaderRow = visibleRows().find((row) => row.includes('Thought'));
    assert.ok(realHeaderRow, 'the collapsed Thought header must be visible after the pinned row clears');
    const headerArrows = (realHeaderRow.match(/[▼▶]/g) ?? []).length;
    assert.equal(headerArrows, 1, `the real header row must render exactly one toggle arrow, got: ${JSON.stringify(realHeaderRow)}`);
    // Expanding again and scrolling the whole block (header + body) past the
    // viewport top hides the pinned row even though later content follows.
    const thoughtRow = await findThoughtRow();
    assert.ok(thoughtRow >= 0);
    await mouse(0, 3, thoughtRow);
    await mouse(0, 3, thoughtRow, true);
    const answerVisible = (): boolean => visibleRows().some((row) => row.includes('Answer text.'));
    const stickyVisible = (): boolean => visibleRows().some((row) => row.includes('Thought') && row.includes('▼'));
    for (let attempt = 0; attempt < 120 && !(await answerVisible()); attempt++) await mouse(65, 3, 5);
    assert.ok(await answerVisible(), 'the scenario must scroll down to the answer');
    for (let attempt = 0; attempt < 120 && (await stickyVisible()); attempt++) await mouse(65, 3, 5);
    assert.ok(!(await stickyVisible()), 'scrolling past the body must hide the pinned header');
    assert.ok(await answerVisible(), 'the answer must remain visible after the pinned header clears');
  } finally {
    await tui.cleanup();
  }
});

test('composer marks shell mode with a $ prompt and shell-colored text', async () => {
  const tui = await startTui({
    modelStream: async function* () {
      yield { content: 'noop', done: true };
    },
  });
  try {
    const { screen, input } = tui;
    input.write('!echo composer-test');
    await tick();
    const shellPrompt = screen.children.find((child) => plainText((child as blessed.Widgets.BoxElement).getContent()) === '$');
    assert.ok(shellPrompt, `composer prompt must switch to $ in shell mode, children: ${screen.children.map((child) => JSON.stringify(plainText((child as blessed.Widgets.BoxElement).getContent()).slice(0, 24)))}`);
    const composerBox = screen.children.find((child) => plainText((child as blessed.Widgets.BoxElement).getContent()).includes('echo composer-test')) as blessed.Widgets.BoxElement | undefined;
    assert.ok(composerBox, 'composer must show the shell draft');
    assert.match(String(composerBox.getContent()), /\x1b\[/, 'shell draft must be color-rendered');
    const editor = screen.focused as blessed.Widgets.BoxElement;
    const conversation = screen.children[1] as blessed.Widgets.BoxElement;
    editor.emit('keypress', '', { name: 'enter' });
    for (let attempt = 0; attempt < 200 && !plainText(conversation.getContent()).includes('! echo composer-test ✓'); attempt++) await wait(10);
    assert.ok(plainText(conversation.getContent()).includes('! echo composer-test ✓'), 'the shell run must complete inline');
    const normalPrompt = screen.children.find((child) => plainText((child as blessed.Widgets.BoxElement).getContent()) === '›');
    assert.ok(normalPrompt, 'prompt must return to › after submit');
  } finally {
    await tui.cleanup();
  }
});

test('shell mode streams inline into the conversation instead of a popup', async () => {
  const tui = await startTui({
    modelStream: async function* () {
      yield { content: 'noop', done: true };
    },
  });
  try {
    const { screen, input } = tui;
    const editor = screen.focused as blessed.Widgets.BoxElement;
    const conversation = screen.children[1] as blessed.Widgets.BoxElement;
    // The splash screen is owned elsewhere: capture whatever banner line is
    // painted (tags stripped) and later assert it yields to the shell run,
    // without hardcoding its content.
    const stripTags = (row: string): string => row.replace(/\{[^}]*\}/g, '');
    let bannerLine = '';
    for (let attempt = 0; attempt < 100 && !bannerLine; attempt++) {
      await wait(10);
      bannerLine = plainText(conversation.getContent()).split('\n').map((row) => stripTags(row).trim()).find((row) => row.length > 0) ?? '';
    }
    input.write('!echo hello-inline && echo more-output');
    await tick();
    editor.emit('keypress', '', { name: 'enter' });
    let rendered = false;
    for (let attempt = 0; attempt < 200 && !rendered; attempt++) {
      await wait(10);
      const text = plainText(conversation.getContent());
      rendered = text.includes('! echo hello-inline && echo more-output') && text.includes('more-output') && text.includes('✓');
    }
    assert.ok(rendered, `shell run must appear inline in the transcript with its status, got: ${JSON.stringify(plainText(conversation.getContent()).split('\n'))}`);
    // The transcript carries the completion marker instead of a modal label;
    // nothing above the composer remains focused.
    const text = plainText(conversation.getContent());
    assert.match(text, /! echo hello-inline && echo more-output ✓/);
    // The banner must yield to the shell run even though no session message
    // exists yet — whatever that banner currently renders.
    if (bannerLine) {
      assert.ok(!text.split('\n').some((row) => stripTags(row).trim() === bannerLine), `welcome banner must disappear once a shell run streams in, banner line: ${JSON.stringify(bannerLine)}`);
    }
  } finally {
    await tui.cleanup();
  }
});

test('/goal shows in the status bar and /goal clear removes it', async () => {
  const tui = await startTui({
    modelStream: async function* () { yield { content: 'ok', done: true }; },
  });
  try {
    const { screen, input } = tui;
    const editor = screen.focused as blessed.Widgets.BoxElement;
    const statusbar = screen.children[0] as blessed.Widgets.BoxElement;
    input.write('/goal ship the refactor by Friday');
    await tick();
    editor.emit('keypress', '', { name: 'enter' });
    let visible = false;
    for (let attempt = 0; attempt < 100 && !visible; attempt++) {
      await wait(10);
      visible = plainText(statusbar.getContent()).includes('ship the refactor by Friday');
    }
    assert.ok(visible, `the goal must show in the status bar, got: ${JSON.stringify(plainText(statusbar.getContent()))}`);
    input.write('/goal clear');
    await tick();
    editor.emit('keypress', '', { name: 'enter' });
    let cleared = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      await wait(10);
      if (!plainText(statusbar.getContent()).includes('ship the refactor by Friday')) break;
      cleared = attempt === 99;
    }
    assert.ok(cleared, 'clearing the goal must remove it from the status bar');
  } finally {
    await tui.cleanup();
  }
});

test('Ctrl+C parks a non-empty draft and Up restores it', async () => {
  const tui = await startTui({
    modelStream: async function* () { yield { content: 'ok', done: true }; },
  });
  try {
    const { screen, input } = tui;
    const editor = screen.focused as blessed.Widgets.BoxElement;
    const conversation = screen.children[1] as blessed.Widgets.BoxElement;
    // pasteActive stays false under the harness input, so this Ctrl+C flows
    // straight into the bare handler.
    input.write('do not lose this draft');
    await tick();
    assert.equal(editor.getContent(), 'do not lose this draft');
    screen.emit('key C-c', '', { full: 'C-c', name: 'c', ctrl: true });
    await tick();
    assert.equal(editor.getContent(), '', 'the first Ctrl+C must park the draft, not quit');
    assert.ok(
      screen.children.some((child) => plainText((child as blessed.Widgets.BoxElement).getContent()).includes('Draft saved')),
      'the status area must announce the parked draft',
    );
    editor.emit('keypress', '', { name: 'up' });
    await tick();
    assert.equal(editor.getContent(), 'do not lose this draft', 'Up must restore the freshly parked draft');
    // Submit the restored draft so the composer is empty again for cleanup:
    // a non-empty composer turns cleanup's first Ctrl+C into another park.
    editor.emit('keypress', '', { name: 'enter' });
    for (let attempt = 0; !plainText(conversation.getContent()).includes('ok') && attempt < 100; attempt++) await wait(10);
    assert.match(plainText(conversation.getContent()), /ok/);
  } finally {
    await tui.cleanup();
  }
});

test('the welcome banner repaints on its own animation clock', async () => {
  const tui = await startTui({
    modelStream: async function* () { yield { content: 'ok', done: true }; },
  });
  try {
    const { screen } = tui;
    const conversation = screen.children[1] as blessed.Widgets.BoxElement;
    let bannerPainted = false;
    for (let attempt = 0; attempt < 100 && !bannerPainted; attempt++) {
      await wait(10);
      bannerPainted = plainText(conversation.getContent()).trim().length > 0;
    }
    assert.ok(bannerPainted, 'the conversation must paint its initial banner');
    const snapshot = (): string => screen.lines.map((row) => row.map((cell) => cell.join(':')).join('|')).join('\n');
    const before = snapshot();
    await wait(400);
    assert.notEqual(snapshot(), before, 'the welcome screen must keep repainting while the session is empty');
  } finally {
    await tui.cleanup();
  }
});

test('blur slows animation to a heartbeat and focus restores full speed', async () => {
  const tui = await startTui({
    modelStream: async function* () { yield { content: 'ok', done: true }; },
  });
  try {
    const { screen, input } = tui;
    const conversation = screen.children[1] as blessed.Widgets.BoxElement;
    let bannerPainted = false;
    for (let attempt = 0; attempt < 100 && !bannerPainted; attempt++) {
      await wait(10);
      bannerPainted = plainText(conversation.getContent()).trim().length > 0;
    }
    assert.ok(bannerPainted, 'the conversation must paint its initial banner');
    const snapshot = (): string => screen.lines.map((row) => row.map((cell) => cell.join(':')).join('|')).join('\n');
    // While focused the 50ms welcome animation must keep repainting.
    const focused = snapshot();
    await wait(150);
    assert.notEqual(snapshot(), focused, 'the welcome screen must animate while the terminal is focused');
    input.write('\x1b[O');
    await wait(80);
    const blurred = snapshot();
    await wait(150);
    assert.equal(snapshot(), blurred, 'welcome decoration must freeze while the terminal is unfocused');
    // Refocusing after a blur that skipped only decoration must resume the
    // decoration at full speed — one live repaint, then steady animation, the
    // opposite of a frozen frame or a replay burst.
    const beforeRefocus = snapshot();
    input.write('\x1b[I');
    await wait(120);
    assert.notEqual(snapshot(), beforeRefocus, 'refocus must resume decoration animation at full speed');
    // Streaming text keeps a heartbeat while blurred: the transcript must keep
    // growing in a background window instead of freezing.
    input.write('\x1b[O');
    await wait(80);
    input.write('streaming while blurred');
    await tick();
    const editor = screen.focused as blessed.Widgets.BoxElement;
    editor.emit('keypress', '', { name: 'enter' });
    let streamed = false;
    for (let attempt = 0; attempt < 60 && !streamed; attempt++) {
      await wait(50);
      streamed = plainText(conversation.getContent()).includes('streaming while blurred');
    }
    assert.ok(streamed, 'streamed text must keep rendering while the terminal is unfocused');
    // Focus regain after skipped frames is treated like one resize: the frame
    // is rebuilt in place from live state. The visible screen must not roll
    // or replay — it simply stays put.
    const finalFocus = snapshot();
    await wait(150);
    assert.equal(snapshot(), finalFocus, 'refocus must rebuild in place without rolling the screen');
    const rebuilt = snapshot();
    await wait(200);
    assert.equal(snapshot(), rebuilt, 'the refocus redraw must be a single rebuild, not a rolling burst');
    await wait(300);
    assert.equal(snapshot(), rebuilt, 'the refocus redraw must settle immediately (no replay burst)');
    await wait(400);
    assert.equal(snapshot(), rebuilt, 'the refocus redraw must not produce further updates');
  } finally {
    await tui.cleanup();
  }
});
