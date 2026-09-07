/**
 * markdown.ts — Lightweight terminal markdown renderer.
 *
 * Emits Blessed style tags (not raw ANSI) so the TUI renders every highlight
 * with theme-driven colors, and exports the theme shape so unit tests and the
 * TUI share one definition. No external dependencies — pure string transform.
 */

export type DiffKind = 'add' | 'del' | 'hunk' | 'file' | 'context';

export interface MarkdownTheme {
  text: string;
  muted: string;
  accent: string;
  heading: string;
  headingStrong: string;
  codeBg: string;
  codeText: string;
  codeFence: string;
  diffAddBg: string;
  diffAddText: string;
  diffDelBg: string;
  diffDelText: string;
}

/** Blessed tags quantize hex colors to the terminal palette; chalk's
 * truecolor SGR sequences are dropped by Blessed's attribute parser, which is
 * why highlights previously rendered as plain white. */
export const DEFAULT_MARKDOWN_THEME: MarkdownTheme = {
  text: '#d7e0ea',
  muted: '#7f92a6',
  accent: '#6fb1d6',
  heading: '#8ac3e6',
  headingStrong: '#d7e0ea',
  codeBg: '#16212d',
  codeText: '#c7d7e6',
  codeFence: '#5f7388',
  diffAddBg: '#10281a',
  diffAddText: '#9fd0a6',
  diffDelBg: '#2b1215',
  diffDelText: '#d99f9f',
};

let currentTheme: MarkdownTheme = DEFAULT_MARKDOWN_THEME;

export function setMarkdownTheme(theme: MarkdownTheme): void {
  currentTheme = theme;
}

export function getMarkdownTheme(): MarkdownTheme {
  return currentTheme;
}

/** Blessed reserves braces for style tags; escape literal ones. */
export function escapeTags(text: string): string {
  return text.replace(/{/g, '{open}').replace(/}/g, '{close}');
}

function fg(color: string, text: string): string {
  return `{${color}-fg}${text}{/${color}-fg}`;
}

/** Italic and strikethrough are not Blessed flags; raw SGR is honored by the
 * content parser and excluded from width measurement. */
function italic(text: string): string {
  return `\x1b[3m${text}\x1b[23m`;
}

function strike(text: string): string {
  return `\x1b[9m${text}\x1b[29m`;
}

function isDiffLanguage(lang: string): boolean {
  return lang.toLowerCase() === 'diff' || lang.toLowerCase() === 'patch';
}

export function diffKind(line: string): DiffKind {
  if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) return 'file';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'del';
  return 'context';
}

export function renderDiffLine(line: string): string {
  const theme = getMarkdownTheme();
  switch (diffKind(line)) {
    case 'add':
      return fg(theme.diffAddText, escapeTags(line));
    case 'del':
      return fg(theme.diffDelText, escapeTags(line));
    case 'hunk':
      return fg(theme.accent, escapeTags(line));
    case 'file':
      return fg(theme.text, escapeTags(line));
    case 'context':
    default:
      return fg(theme.muted, escapeTags(line));
  }
}

function renderCodeLine(lang: string, line: string): string {
  return isDiffLanguage(lang) ? renderDiffLine(line) : fg(getMarkdownTheme().codeText, escapeTags(line));
}

// ── GFM pipe tables ──────────────────────────────────────────────────────────

export type TableAlign = 'left' | 'center' | 'right';

export interface GfmTable {
  header: string[];
  aligns: TableAlign[];
  rows: string[][];
}

const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
const TAG_PATTERN = /\{[^{}]*\}/g;

/** Display width ignoring ANSI escapes and style tags, counting East-Asian
 * wide chars as 2 columns. */
export function displayWidth(text: string): number {
  const clean = text.replace(ANSI_PATTERN, '').replace(TAG_PATTERN, '');
  let width = 0;
  for (const ch of clean) {
    const code = ch.codePointAt(0)!;
    const wide = (code >= 0x1100 && code <= 0x115F)
      || (code >= 0x2E80 && code <= 0x303E)
      || (code >= 0x3130 && code <= 0x4DBF)
      || (code >= 0x4E00 && code <= 0x9FFF)
      || (code >= 0xA000 && code <= 0xA4CF)
      || (code >= 0xAC00 && code <= 0xD7A3)
      || (code >= 0xF900 && code <= 0xFAFF)
      || (code >= 0xFE30 && code <= 0xFE4F)
      || (code >= 0xFF00 && code <= 0xFF60)
      || (code >= 0xFFE0 && code <= 0xFFE6)
      || (code >= 0x1F300 && code <= 0x1FAFF)
      || (code >= 0x20000 && code <= 0x3FFFD);
    width += wide ? 2 : 1;
  }
  return width;
}

function splitCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);
  return trimmed
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function delimiterCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;
  const cells = splitCells(trimmed);
  if (!cells.length || !cells.every((cell) => /^:?-+:?$/.test(cell))) return null;
  return cells;
}

/** Match a GFM pipe table starting at lines[start]. Returns null when absent. */
export function matchGfmTable(lines: string[], start: number): { table: GfmTable; end: number } | null {
  const headerLine = lines[start];
  const delimiterLine = lines[start + 1];
  if (!headerLine || !delimiterLine) return null;
  if (!headerLine.includes('|')) return null;
  const alignCells = delimiterCells(delimiterLine);
  if (!alignCells) return null;
  const header = splitCells(headerLine);
  if (header.length !== alignCells.length) return null;
  const aligns = alignCells.map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left') as TableAlign);
  const rows: string[][] = [];
  let end = start + 2;
  while (end < lines.length) {
    const line = lines[end]!;
    if (!line.includes('|') || !line.trim() || /^```/.test(line) || /^#{1,6} /.test(line)) break;
    const cells = splitCells(line);
    while (cells.length < header.length) cells.push('');
    rows.push(cells.slice(0, header.length));
    end += 1;
  }
  return { table: { header, aligns, rows }, end };
}

function truncateToWidth(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text;
  let out = '';
  let width = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (width + w > maxWidth - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

/** Render a parsed table as aligned monospace lines that fit within maxWidth columns. */
export function renderGfmTable(table: GfmTable, maxWidth: number): string[] {
  const theme = getMarkdownTheme();
  const columns = table.header.length;
  const gap = ' │ ';
  const gapWidth = displayWidth(gap);
  const minWidth = 4;
  const widths = table.header.map((cell, index) => Math.max(
    displayWidth(cell),
    ...table.rows.map((row) => displayWidth(row[index] ?? '')),
    minWidth,
  ));
  const totalWidth = (): number => widths.reduce((sum, width) => sum + width, 0) + gapWidth * (columns - 1);
  if (totalWidth() > maxWidth) {
    const shrinkable = widths.map((_, index) => index).filter((index) => widths[index]! > minWidth);
    shrinkable.sort((a, b) => widths[b]! - widths[a]!);
    let overflow = totalWidth() - maxWidth;
    for (const index of shrinkable) {
      if (overflow <= 0) break;
      const reduce = Math.min(overflow, widths[index]! - minWidth);
      widths[index] = widths[index]! - reduce;
      overflow -= reduce;
    }
  }
  const padCell = (plain: string, width: number, align: TableAlign): string => {
    const padding = Math.max(0, width - displayWidth(plain));
    if (align === 'right') return ' '.repeat(padding) + plain;
    if (align === 'center') {
      const left = Math.floor(padding / 2);
      return ' '.repeat(left) + plain + ' '.repeat(padding - left);
    }
    return plain + ' '.repeat(padding);
  };
  // Pad the plain cell first, then style — so padding never measures tags.
  const renderRow = (cells: string[], style: (plain: string) => string): string => cells
    .map((cell, index) => {
      const width = widths[index]!;
      const plain = displayWidth(cell) > width ? truncateToWidth(cell, width) : cell;
      return style(padCell(plain, width, table.aligns[index]!));
    })
    .join(fg(theme.muted, gap));

  const header = renderRow(table.header, (plain) => fg(theme.accent, `{bold}${inlineMarkdown(plain)}{/bold}`));
  // One uniform border color for every structural character (│, ─, ┼).
  const separator = fg(theme.muted, widths.map((width) => '─'.repeat(width)).join('─┼─'));
  const body = table.rows.map((row) => renderRow(row, (plain) => inlineMarkdown(plain)));
  return [header, separator, ...body];
}

export function inlineMarkdown(text: string): string {
  const theme = getMarkdownTheme();
  return escapeTags(text)
    .replace(/\*\*\*(.+?)\*\*\*/g, (_m, t: string) => `{bold}${italic(t)}{/bold}`)
    .replace(/\*\*(.+?)\*\*/g,     (_m, t: string) => `{bold}${t}{/bold}`)
    .replace(/__(.+?)__/g,         (_m, t: string) => `{bold}${t}{/bold}`)
    .replace(/\*(.+?)\*/g,         (_m, t: string) => italic(t))
    .replace(/_(.+?)_/g,           (_m, t: string) => italic(t))
    .replace(/`([^`]+)`/g,         (_m, t: string) => `{${theme.codeBg}-bg}{${theme.codeText}-fg} ${t} {/${theme.codeText}-fg}{/${theme.codeBg}-bg}`)
    .replace(/~~(.+?)~~/g,         (_m, t: string) => strike(t));
}

export function renderMarkdown(text: string, cols = 80): string {
  const theme = getMarkdownTheme();
  const lines = text.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    const fenceMatch = raw.match(/^```(\w*)$/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = fenceMatch[1] ?? '';
        codeLines = [];
      } else {
        inCodeBlock = false;
        const langLabel = codeLang ? fg(theme.muted, italic(` ${escapeTags(codeLang)}`)) : '';
        out.push(fg(theme.codeFence, '┌' + '─'.repeat(Math.max(2, cols - 2))) + langLabel);
        for (const cl of codeLines) {
          out.push(fg(theme.codeFence, '│ ') + renderCodeLine(codeLang, cl));
        }
        out.push(fg(theme.codeFence, '└' + '─'.repeat(Math.max(2, cols - 2))));
        codeLang = '';
        codeLines = [];
      }
      continue;
    }
    if (inCodeBlock) { codeLines.push(raw); continue; }

    const h1 = raw.match(/^# (.+)/);
    const h2 = raw.match(/^## (.+)/);
    const h3 = raw.match(/^### (.+)/);
    if (h1) { out.push('\n' + fg(theme.heading, `{bold}${escapeTags(h1[1]!)}{/bold}`)); continue; }
    if (h2) { out.push('\n' + fg(theme.headingStrong, `{bold}${escapeTags(h2[1]!)}{/bold}`)); continue; }
    if (h3) { out.push(`{bold}${escapeTags(h3[1]!)}{/bold}`); continue; }

    if (/^---+$/.test(raw) || /^\*\*\*+$/.test(raw)) {
      out.push(fg(theme.muted, '─'.repeat(cols)));
      continue;
    }

    const tableMatch = matchGfmTable(lines, index);
    if (tableMatch) {
      out.push(...renderGfmTable(tableMatch.table, cols));
      index = tableMatch.end - 1;
      continue;
    }

    const bullet = raw.match(/^(\s*)[*\-+] (.+)/);
    if (bullet) {
      out.push((bullet[1] ?? '') + fg(theme.accent, '•') + ' ' + inlineMarkdown(bullet[2] ?? ''));
      continue;
    }

    const numbered = raw.match(/^(\s*)(\d+)\. (.+)/);
    if (numbered) {
      out.push(
        (numbered[1] ?? '') +
          fg(theme.accent, escapeTags(numbered[2]! + '.')) +
          ' ' +
          inlineMarkdown(numbered[3] ?? ''),
      );
      continue;
    }

    const bq = raw.match(/^> (.+)/);
    if (bq) { out.push(fg(theme.muted, '│ ') + fg(theme.muted, italic(escapeTags(bq[1]!)))); continue; }

    out.push(inlineMarkdown(raw));
  }

  if (inCodeBlock && codeLines.length > 0) {
    out.push(fg(theme.codeFence, '┌─'));
    for (const cl of codeLines) {
      out.push(fg(theme.codeFence, '│ ') + renderCodeLine(codeLang, cl));
    }
    out.push(fg(theme.codeFence, '└─'));
  }

  return out.join('\n');
}
