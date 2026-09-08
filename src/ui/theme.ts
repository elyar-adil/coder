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

const tokyoNight: TuiTheme = {
  name: 'tokyo-night', label: 'Tokyo Night · neon dusk',
  ui: { background: '#1a1b26', panel: '#16161e', composer: '#1f2335', activity: '#1c1d2b', elevated: '#292e42', modal: '#1f2335', modalRule: '#2f334d', line: '#3b4261', text: '#c0caf5', muted: '#a9b1d6', subtle: '#565f89', accent: '#7aa2f7', success: '#9ece6a', warning: '#e0af68', error: '#f7768e' },
  markdown: { text: '#c0caf5', muted: '#565f89', accent: '#7dcfff', heading: '#7aa2f7', headingStrong: '#c0caf5', codeBg: '#16161e', codeText: '#a9b1d6', codeFence: '#3b4261', diffAddBg: '#1e2a24', diffAddText: '#9ece6a', diffDelBg: '#2d202a', diffDelText: '#f7768e' },
  syntax: ['#565f89', '#9ece6a', '#bb9af7', '#7aa2f7', '#ff9e64'],
};

const catppuccinMocha: TuiTheme = {
  name: 'catppuccin-mocha', label: 'Catppuccin Mocha · pastel night',
  ui: { background: '#1e1e2e', panel: '#181825', composer: '#242438', activity: '#181825', elevated: '#313244', modal: '#1b1b2a', modalRule: '#45475a', line: '#313244', text: '#cdd6f4', muted: '#a6adc8', subtle: '#6c7086', accent: '#89b4fa', success: '#a6e3a1', warning: '#f9e2af', error: '#f38ba8' },
  markdown: { text: '#cdd6f4', muted: '#6c7086', accent: '#89b4fa', heading: '#cba6f7', headingStrong: '#cdd6f4', codeBg: '#181825', codeText: '#cdd6f4', codeFence: '#45475a', diffAddBg: '#20312a', diffAddText: '#a6e3a1', diffDelBg: '#3b2530', diffDelText: '#f38ba8' },
  syntax: ['#6c7086', '#a6e3a1', '#cba6f7', '#89b4fa', '#fab387'],
};

const catppuccinLatte: TuiTheme = {
  name: 'catppuccin-latte', label: 'Catppuccin Latte · pastel light',
  ui: { background: '#eff1f5', panel: '#e6e9ef', composer: '#e6e9ef', activity: '#dce0e8', elevated: '#ccd0da', modal: '#f4f6fb', modalRule: '#bcc0cc', line: '#bcc0cc', text: '#4c4f69', muted: '#6c6f85', subtle: '#9ca0b0', accent: '#1e66f5', success: '#40a02b', warning: '#df8e1d', error: '#d20f39' },
  markdown: { text: '#4c4f69', muted: '#9ca0b0', accent: '#1e66f5', heading: '#8839ef', headingStrong: '#4c4f69', codeBg: '#e6e9ef', codeText: '#4c4f69', codeFence: '#acb0be', diffAddBg: '#dcefdd', diffAddText: '#28731c', diffDelBg: '#f4dbdc', diffDelText: '#d20f39' },
  syntax: ['#9ca0b0', '#40a02b', '#8839ef', '#1e66f5', '#fe640b'],
};

const gruvboxDark: TuiTheme = {
  name: 'gruvbox-dark', label: 'Gruvbox Dark · retro groove',
  ui: { background: '#282828', panel: '#1d2021', composer: '#32302f', activity: '#2c2c28', elevated: '#3c3836', modal: '#2d2c29', modalRule: '#504945', line: '#504945', text: '#ebdbb2', muted: '#d5c4a1', subtle: '#928374', accent: '#fe8019', success: '#b8bb26', warning: '#fabd2f', error: '#fb4934' },
  markdown: { text: '#ebdbb2', muted: '#928374', accent: '#83a598', heading: '#fabd2f', headingStrong: '#ebdbb2', codeBg: '#1d2021', codeText: '#ebdbb2', codeFence: '#504945', diffAddBg: '#2f331f', diffAddText: '#b8bb26', diffDelBg: '#3c2321', diffDelText: '#fb4934' },
  syntax: ['#928374', '#b8bb26', '#fb4934', '#83a598', '#d3869b'],
};

const oneDark: TuiTheme = {
  name: 'one-dark', label: 'One Dark · atom classic',
  ui: { background: '#282c34', panel: '#21252b', composer: '#2f343d', activity: '#23272e', elevated: '#3a3f4b', modal: '#2a2e37', modalRule: '#3e4451', line: '#3e4451', text: '#abb2bf', muted: '#828997', subtle: '#5c6370', accent: '#61afef', success: '#98c379', warning: '#e5c07b', error: '#e06c75' },
  markdown: { text: '#abb2bf', muted: '#5c6370', accent: '#56b6c2', heading: '#61afef', headingStrong: '#d7dae0', codeBg: '#21252b', codeText: '#abb2bf', codeFence: '#3e4451', diffAddBg: '#243129', diffAddText: '#98c379', diffDelBg: '#38262a', diffDelText: '#e06c75' },
  syntax: ['#5c6370', '#98c379', '#c678dd', '#61afef', '#d19a66'],
};

const monokai: TuiTheme = {
  name: 'monokai', label: 'Monokai · classic pop',
  ui: { background: '#272822', panel: '#1e1f1c', composer: '#2d2e27', activity: '#262721', elevated: '#3e3d32', modal: '#2b2c25', modalRule: '#49483e', line: '#49483e', text: '#f8f8f2', muted: '#a8a89d', subtle: '#75715e', accent: '#66d9ef', success: '#a6e22e', warning: '#e6db74', error: '#f92672' },
  markdown: { text: '#f8f8f2', muted: '#75715e', accent: '#a6e22e', heading: '#fd971f', headingStrong: '#f8f8f2', codeBg: '#1e1f1c', codeText: '#f8f8f2', codeFence: '#49483e', diffAddBg: '#2a331d', diffAddText: '#a6e22e', diffDelBg: '#3a1f26', diffDelText: '#f92672' },
  syntax: ['#75715e', '#e6db74', '#f92672', '#66d9ef', '#ae81ff'],
};

const kanagawa: TuiTheme = {
  name: 'kanagawa', label: 'Kanagawa · ink wash',
  ui: { background: '#1f1f28', panel: '#16161d', composer: '#2a2a37', activity: '#1a1a22', elevated: '#363649', modal: '#262635', modalRule: '#363649', line: '#54546d', text: '#dcd7ba', muted: '#c8c093', subtle: '#727169', accent: '#7e9cd8', success: '#98bb6c', warning: '#ff9e3b', error: '#e82424' },
  markdown: { text: '#dcd7ba', muted: '#727169', accent: '#7fb4ca', heading: '#957fb8', headingStrong: '#dcd7ba', codeBg: '#16161d', codeText: '#dcd7ba', codeFence: '#54546d', diffAddBg: '#2a332e', diffAddText: '#98bb6c', diffDelBg: '#43242b', diffDelText: '#e82424' },
  syntax: ['#727169', '#98bb6c', '#957fb8', '#7fb4ca', '#ff9e3b'],
};

const everforest: TuiTheme = {
  name: 'everforest', label: 'Everforest · moss green',
  ui: { background: '#2d353b', panel: '#272e33', composer: '#343f44', activity: '#2e373d', elevated: '#3d484d', modal: '#333e44', modalRule: '#475258', line: '#475258', text: '#d3c6aa', muted: '#9da9a0', subtle: '#7a8478', accent: '#a7c080', success: '#83c092', warning: '#dbbc7f', error: '#e67e80' },
  markdown: { text: '#d3c6aa', muted: '#7a8478', accent: '#7fbbb3', heading: '#dbbc7f', headingStrong: '#d3c6aa', codeBg: '#272e33', codeText: '#d3c6aa', codeFence: '#475258', diffAddBg: '#2f3a2d', diffAddText: '#a7c080', diffDelBg: '#452f2c', diffDelText: '#e67e80' },
  syntax: ['#7a8478', '#a7c080', '#d699b6', '#7fbbb3', '#dbbc7f'],
};

const synthwave: TuiTheme = {
  name: 'synthwave', label: "SynthWave '84 · neon grid",
  ui: { background: '#262335', panel: '#211d2e', composer: '#2c2840', activity: '#252138', elevated: '#3a3454', modal: '#2a2540', modalRule: '#443d63', line: '#443d63', text: '#f8f8f4', muted: '#a5a1bd', subtle: '#6f6a8a', accent: '#ff7edb', success: '#72f1b8', warning: '#fede5d', error: '#fe4450' },
  markdown: { text: '#f8f8f4', muted: '#6f6a8a', accent: '#ff7edb', heading: '#36f9f6', headingStrong: '#f8f8f4', codeBg: '#1e1c2c', codeText: '#d9d6e8', codeFence: '#443d63', diffAddBg: '#1e332c', diffAddText: '#72f1b8', diffDelBg: '#3a2233', diffDelText: '#fe4450' },
  syntax: ['#6f6a8a', '#fede5d', '#ff7edb', '#36f9f6', '#fe8b48'],
};

const solarizedLight: TuiTheme = {
  name: 'solarized-light', label: 'Solarized Light · paper',
  ui: { background: '#fdf6e3', panel: '#eee8d5', composer: '#f4eedd', activity: '#ece5d3', elevated: '#ddd5c1', modal: '#f2ecdb', modalRule: '#ccc4ae', line: '#afa897', text: '#657b83', muted: '#93a1a1', subtle: '#a4aeab', accent: '#268bd2', success: '#859900', warning: '#b58900', error: '#dc322f' },
  markdown: { text: '#657b83', muted: '#93a1a1', accent: '#268bd2', heading: '#268bd2', headingStrong: '#586e75', codeBg: '#eee8d5', codeText: '#657b83', codeFence: '#93a1a1', diffAddBg: '#e3eedd', diffAddText: '#859900', diffDelBg: '#f3dfdb', diffDelText: '#dc322f' },
  syntax: ['#93a1a1', '#859900', '#6c71c4', '#268bd2', '#cb4b16'],
};

const githubLight: TuiTheme = {
  name: 'github-light', label: 'GitHub Light · clean day',
  ui: { background: '#ffffff', panel: '#f6f8fa', composer: '#f6f8fa', activity: '#eef1f4', elevated: '#e7ebef', modal: '#fafbfc', modalRule: '#d0d7de', line: '#d0d7de', text: '#1f2328', muted: '#656d76', subtle: '#8b949e', accent: '#0969da', success: '#1a7f37', warning: '#9a6700', error: '#cf222e' },
  markdown: { text: '#1f2328', muted: '#656d76', accent: '#0969da', heading: '#0969da', headingStrong: '#1f2328', codeBg: '#f6f8fa', codeText: '#1f2328', codeFence: '#d0d7de', diffAddBg: '#dafbe1', diffAddText: '#116329', diffDelBg: '#ffebe9', diffDelText: '#a40e26' },
  syntax: ['#6e7781', '#0a3069', '#cf222e', '#8250df', '#0550ae'],
};

export const THEMES: Record<string, TuiTheme> = {
  midnight, nord, dracula, dawn, solarized, 'rose-pine': rosePine,
  'tokyo-night': tokyoNight, 'catppuccin-mocha': catppuccinMocha, 'catppuccin-latte': catppuccinLatte,
  'gruvbox-dark': gruvboxDark, 'one-dark': oneDark, monokai, kanagawa, everforest, synthwave,
  'solarized-light': solarizedLight, 'github-light': githubLight,
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
