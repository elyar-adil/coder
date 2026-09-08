import type { MarkdownTheme } from '../markdown.js';
import { setMarkdownTheme } from '../markdown.js';

export type Tone = 'muted' | 'accent' | 'success' | 'warning' | 'error';

export interface TuiThemeColors {
  background: string;
  panel: string;
  composer: string;
  activity: string;
  elevated: string;
  modal: string;
  modalRule: string;
  line: string;
  text: string;
  muted: string;
  subtle: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
}

export interface TuiTheme {
  name: string;
  label: string;
  ui: TuiThemeColors;
  markdown: MarkdownTheme;
  /** Lexical token colors for code blocks: comment, string, keyword, attr, number. */
  syntax: [string, string, string, string, string];
}

const midnight: TuiTheme = {
  name: 'midnight',
  label: 'Midnight · deep blue-black',
  ui: {
    background: 'black', panel: 'black', composer: '#171c23', activity: '#11161c',
    elevated: '#242c36', modal: '#171a1f', modalRule: '#2b3139', line: 'gray',
    text: 'light-white', muted: 'white', subtle: 'gray', accent: 'light-cyan', success: 'light-green',
    warning: 'light-yellow', error: 'light-red',
  },
  markdown: {
    text: '#d7e0ea', muted: '#7f92a6', accent: '#6fb1d6',
    heading: '#8ac3e6', headingStrong: '#d7e0ea',
    codeBg: '#16212d', codeText: '#c7d7e6', codeFence: '#5f7388',
    diffAddBg: '#10281a', diffAddText: '#9fd0a6',
    diffDelBg: '#2b1215', diffDelText: '#d99f9f',
  },
  syntax: ['#84918b', '#cead83', '#ba9ce0', '#87b9db', '#d493b5'],
};

const nord: TuiTheme = {
  name: 'nord',
  label: 'Nord · arctic blue',
  ui: {
    background: '#2e3440', panel: '#2e3440', composer: '#3b4252', activity: '#333b47',
    elevated: '#434c5e', modal: '#353c4a', modalRule: '#4c566a', line: '#4c566a',
    text: '#eceff4', muted: '#d8dee9', subtle: '#7b88a1', accent: '#88c0d0', success: '#a3be8c',
    warning: '#ebcb8b', error: '#bf616a',
  },
  markdown: {
    text: '#eceff4', muted: '#7b88a1', accent: '#81a1c1',
    heading: '#88c0d0', headingStrong: '#eceff4',
    codeBg: '#353c4a', codeText: '#d8dee9', codeFence: '#4c566a',
    diffAddBg: '#2f4032', diffAddText: '#a3be8c',
    diffDelBg: '#46302c', diffDelText: '#d08770',
  },
  syntax: ['#7b88a1', '#ebcb8b', '#b48ead', '#81a1c1', '#d08770'],
};

const dracula: TuiTheme = {
  name: 'dracula',
  label: 'Dracula · purple night',
  ui: {
    background: '#282a36', panel: '#282a36', composer: '#343746', activity: '#2f3141',
    elevated: '#44475a', modal: '#2b2d3a', modalRule: '#44475a', line: '#44475a',
    text: '#f8f8f2', muted: '#b6bcc9', subtle: '#6272a4', accent: '#bd93f9', success: '#50fa7b',
    warning: '#f1fa8c', error: '#ff5555',
  },
  markdown: {
    text: '#f8f8f2', muted: '#6272a4', accent: '#8be9fd',
    heading: '#bd93f9', headingStrong: '#f8f8f2',
    codeBg: '#21222c', codeText: '#e2e2dc', codeFence: '#6272a4',
    diffAddBg: '#1f3a2b', diffAddText: '#7ff0a5',
    diffDelBg: '#3a2430', diffDelText: '#ff8b8b',
  },
  syntax: ['#6272a4', '#f1fa8c', '#bd93f9', '#8be9fd', '#ff79c6'],
};

const dawn: TuiTheme = {
  name: 'dawn',
  label: 'Dawn · warm light',
  ui: {
    background: '#f7f4ee', panel: '#efece4', composer: '#f0ece2', activity: '#eceade',
    elevated: '#dcd7c8', modal: '#f2efe8', modalRule: '#c9c2b2', line: '#b9b2a2',
    text: '#3b3a36', muted: '#5c584f', subtle: '#8f897a', accent: '#1f6f8b', success: '#4a7c3f',
    warning: '#a8760a', error: '#b3413a',
  },
  markdown: {
    text: '#3b3a36', muted: '#8f897a', accent: '#1f6f8b',
    heading: '#1f6f8b', headingStrong: '#2f2e2a',
    codeBg: '#e8e3d6', codeText: '#3b3a36', codeFence: '#a49c88',
    diffAddBg: '#dcead2', diffAddText: '#2e5c28',
    diffDelBg: '#f2dcd8', diffDelText: '#96372f',
  },
  syntax: ['#6f6a5c', '#8a5a20', '#5b4392', '#1f5c8b', '#8f3a63'],
};

const solarized: TuiTheme = {
  name: 'solarized', label: 'Solarized · balanced contrast',
  ui: { background: '#002b36', panel: '#073642', composer: '#0b3b46', activity: '#06323d', elevated: '#14505b', modal: '#0b3b46', modalRule: '#1b5963', line: '#496b70', text: '#eee8d5', muted: '#c7c0a8', subtle: '#839496', accent: '#2aa198', success: '#859900', warning: '#b58900', error: '#dc322f' },
  markdown: { text: '#eee8d5', muted: '#839496', accent: '#2aa198', heading: '#268bd2', headingStrong: '#fdf6e3', codeBg: '#073642', codeText: '#eee8d5', codeFence: '#586e75', diffAddBg: '#193b31', diffAddText: '#b7d68a', diffDelBg: '#4a2528', diffDelText: '#f28b82' },
  syntax: ['#839496', '#2aa198', '#859900', '#268bd2', '#d33682'],
};

const rosePine: TuiTheme = {
  name: 'rose-pine', label: 'Rosé Pine · soft dusk',
  ui: { background: '#191724', panel: '#1f1d2e', composer: '#26233a', activity: '#211f32', elevated: '#393552', modal: '#26233a', modalRule: '#403d52', line: '#524f67', text: '#e0def4', muted: '#c4a7e7', subtle: '#908caa', accent: '#ebbcba', success: '#9ccfd8', warning: '#f6c177', error: '#eb6f92' },
  markdown: { text: '#e0def4', muted: '#908caa', accent: '#ebbcba', heading: '#c4a7e7', headingStrong: '#fffaf3', codeBg: '#1f1d2e', codeText: '#e0def4', codeFence: '#6e6a86', diffAddBg: '#20373b', diffAddText: '#9ccfd8', diffDelBg: '#422638', diffDelText: '#eb6f92' },
  syntax: ['#908caa', '#f6c177', '#c4a7e7', '#9ccfd8', '#ebbcba'],
};

export const THEMES: Record<string, TuiTheme> = {
  midnight, nord, dracula, dawn, solarized, 'rose-pine': rosePine,
};

export const DEFAULT_THEME = 'midnight';

export function themeNames(): string[] {
  return Object.keys(THEMES);
}

export function resolveTheme(name?: string): TuiTheme {
  const key = name?.toLowerCase() ?? '';
  return (key && Object.hasOwn(THEMES, key) ? THEMES[key] : undefined) ?? THEMES[DEFAULT_THEME]!;
}

let activeTheme = THEMES[DEFAULT_THEME]!;

export function activeTuiTheme(): TuiTheme {
  return activeTheme;
}

export function setActiveTheme(name: string | undefined): TuiTheme {
  activeTheme = resolveTheme(name);
  setMarkdownTheme(activeTheme.markdown);
  return activeTheme;
}
