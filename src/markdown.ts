/**
 * markdown.ts — Lightweight terminal markdown renderer.
 *
 * Emits Blessed style tags (not raw ANSI) so the TUI renders every highlight
 * with theme-driven colors, and exports the theme shape so unit tests and the
 * TUI share one definition. No external dependencies — pure string transform.
 */

import { Lexer, type Token } from 'marked';
import { displayWidth, styledWidth, truncateStyled, truncateToDisplayWidth, wrapText } from './ui/text-width.js';
import { closesFence, openingFence, type MarkdownFence } from './ui/markdown-fence.js';

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
  return text.replace(/[{}]/g, (char) => char === '{' ? '{open}' : '{close}');
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

// Keep the historical Markdown export while sharing the same width rules as
// status bars, Activity rows, the composer and diff previews.
export { displayWidth, truncateToDisplayWidth } from './ui/text-width.js';

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

/** Render a parsed table as aligned monospace lines that fit within maxWidth columns. */
export function renderGfmTable(table: GfmTable, maxWidth: number): string[] {
  const theme = getMarkdownTheme();
  const columns = table.header.length;
  const gap = ' │ ';
  const gapWidth = displayWidth(gap);
  const minWidth = 4;
  const renderedHeader = table.header.map(inlineMarkdown);
  const renderedRows = table.rows.map((row) => row.map(inlineMarkdown));
  // Narrow screens cannot fit many columns even at minimum width. Display
  // labeled fields instead of letting wrapped separators destroy the table.
  if (columns * minWidth + gapWidth * (columns - 1) > maxWidth) {
    return [renderedHeader, ...renderedRows].flatMap((row, index) => [
      ...(index > 0 ? [''] : []),
      ...row.map((cell, column) => truncateStyled(index === 0 ? cell : renderedHeader[column] + ': ' + cell, maxWidth)),
    ]);
  }
  const widths = table.header.map((cell, index) => Math.max(
    styledWidth(renderedHeader[index]!),
    ...renderedRows.map((row) => styledWidth(row[index] ?? '')),
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
    const padding = Math.max(0, width - styledWidth(plain));
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
      const plain = truncateStyled(cell, width);
      return style(padCell(plain, width, table.aligns[index]!));
    })
    .join(fg(theme.muted, gap));

  const header = renderRow(renderedHeader, (plain) => fg(theme.accent, `{bold}${plain}{/bold}`));
  // One uniform border color for every structural character (│, ─, ┼).
  const separator = fg(theme.muted, widths.map((width) => '─'.repeat(width)).join('─┼─'));
  const body = renderedRows.map((row) => renderRow(row, (plain) => plain));
  return [header, separator, ...body];
}

export function inlineMarkdown(text: string): string {
  const theme = getMarkdownTheme();
  const renderTokens = (tokens: Token[]): string => tokens.map((token): string => {
    switch (token.type) {
      case 'strong': return '{bold}' + renderTokens(token.tokens ?? []) + '{/bold}';
      case 'em': return italic(renderTokens(token.tokens ?? []));
      case 'del': return strike(renderTokens(token.tokens ?? []));
      case 'codespan': return '{' + theme.codeBg + '-bg}' + fg(theme.codeText, escapeTags(token.text)) + '{/' + theme.codeBg + '-bg}';
      case 'link': {
        const label = renderTokens(token.tokens ?? []);
        return label + (token.text === token.href ? '' : ' (' + escapeTags(token.href) + ')');
      }
      case 'br': return '\n';
      case 'escape': return escapeTags(token.text);
      default: return escapeTags('text' in token ? String(token.text) : token.raw);
    }
  }).join('');
  return renderTokens(Lexer.lexInline(text));
}

export interface MarkdownOptions {
  codeBlock?: (lines: string[], language: string, columns: number) => string[];
}

function renderCodeBlock(lines: string[], language: string, columns: number): string[] {
  const theme = getMarkdownTheme();
  const label = language ? ' ' + truncateToDisplayWidth(language, Math.max(0, columns - 3)) + ' ' : '';
  const top = '┌' + label + '─'.repeat(Math.max(0, columns - displayWidth(label) - 1));
  return [
    fg(theme.codeFence, top),
    ...lines.flatMap((line) => wrapText(line, Math.max(2, columns - 2))
      .map((part) => fg(theme.codeFence, '│ ') + renderCodeLine(language, part))),
    fg(theme.codeFence, '└' + '─'.repeat(Math.max(0, columns - 1))),
  ];
}

export function renderMarkdown(text: string, cols = 80, options: MarkdownOptions = {}): string {
  const theme = getMarkdownTheme();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let fence: MarkdownFence | undefined;
  let codeLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (fence) {
      if (closesFence(raw, fence)) {
        out.push(...(options.codeBlock ?? renderCodeBlock)(codeLines, fence.language, cols));
        fence = undefined;
        codeLines = [];
      } else {
        codeLines.push(raw);
      }
      continue;
    }
    fence = openingFence(raw);
    if (fence) continue;

    const heading = raw.match(/^\s*(#{1,6})\s+(.+)/);
    if (heading) {
      const level = heading[1]!.length;
      const color = level === 2 ? theme.headingStrong : theme.heading;
      const prefix = level <= 2 ? '\n' : '';
      out.push(prefix + fg(color, `{bold}${escapeTags(heading[2]!)}{/bold}`));
      continue;
    }

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

  if (fence) {
    out.push(...(options.codeBlock ?? renderCodeBlock)(codeLines, fence.language, cols));
  }

  return out.join('\n');
}
