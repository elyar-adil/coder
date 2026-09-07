/**
 * markdown.ts — Lightweight terminal markdown renderer.
 *
 * Exported so it can be unit-tested independently of the TUI.
 * No external dependencies — pure string transformation.
 */

import chalk from 'chalk';

const MARKDOWN_THEME = {
  text: '#d7e0ea',
  muted: '#7f92a6',
  accent: '#6fb1d6',
  accentStrong: '#8ac3e6',
  codeBg: '#16212d',
  codeText: '#c7d7e6',
  codeFence: '#5f7388',
  codeGreen: '#8ebd93',
  codeRed: '#c97c7c',
} as const;

export type DiffKind = 'add' | 'del' | 'hunk' | 'file' | 'context';

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
  switch (diffKind(line)) {
    case 'add':
      return chalk.hex(MARKDOWN_THEME.codeGreen)(line);
    case 'del':
      return chalk.hex(MARKDOWN_THEME.codeRed)(line);
    case 'hunk':
      return chalk.hex(MARKDOWN_THEME.accent)(line);
    case 'file':
      return chalk.bold.hex(MARKDOWN_THEME.text)(line);
    case 'context':
    default:
      return chalk.hex(MARKDOWN_THEME.muted)(line);
  }
}

function renderCodeLine(lang: string, line: string): string {
  return isDiffLanguage(lang) ? renderDiffLine(line) : chalk.hex(MARKDOWN_THEME.codeText)(line);
}

// ── GFM pipe tables ──────────────────────────────────────────────────────────

export type TableAlign = 'left' | 'center' | 'right';

export interface GfmTable {
  header: string[];
  aligns: TableAlign[];
  rows: string[][];
}

const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Display width ignoring ANSI escapes, counting East-Asian wide chars as 2 columns. */
export function displayWidth(text: string): number {
  const clean = text.replace(ANSI_PATTERN, '');
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
  const padCell = (rendered: string, width: number, align: TableAlign): string => {
    const padding = Math.max(0, width - displayWidth(rendered));
    if (align === 'right') return ' '.repeat(padding) + rendered;
    if (align === 'center') {
      const left = Math.floor(padding / 2);
      return ' '.repeat(left) + rendered + ' '.repeat(padding - left);
    }
    return rendered + ' '.repeat(padding);
  };
  const renderRow = (cells: string[], style: (cell: string) => string): string => cells
    .map((cell, index) => {
      const width = widths[index]!;
      const plain = displayWidth(cell) > width ? truncateToWidth(cell, width) : cell;
      return padCell(style(plain), width, table.aligns[index]!);
    })
    .join(chalk.hex(MARKDOWN_THEME.muted)(gap));

  const header = renderRow(table.header, (cell) => chalk.bold.hex(MARKDOWN_THEME.accent)(inlineMarkdown(cell)));
  // One uniform border color for every structural character (│, ─, ┼).
  const separator = chalk.hex(MARKDOWN_THEME.muted)(widths.map((width) => '─'.repeat(width)).join('─┼─'));
  const body = table.rows.map((row) => renderRow(row, (cell) => inlineMarkdown(cell)));
  return [header, chalk.hex(MARKDOWN_THEME.muted)(separator), ...body];
}

export function inlineMarkdown(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, (_m, t: string) => chalk.bold.italic(t))
    .replace(/\*\*(.+?)\*\*/g,     (_m, t: string) => chalk.bold(t))
    .replace(/__(.+?)__/g,         (_m, t: string) => chalk.bold(t))
    .replace(/\*(.+?)\*/g,         (_m, t: string) => chalk.italic(t))
    .replace(/_(.+?)_/g,           (_m, t: string) => chalk.italic(t))
    .replace(/`([^`]+)`/g,         (_m, t: string) => chalk.bgHex(MARKDOWN_THEME.codeBg).hex(MARKDOWN_THEME.codeText)(` ${t} `))
    .replace(/~~(.+?)~~/g,         (_m, t: string) => chalk.strikethrough(t));
}

export function renderMarkdown(text: string, cols = 80): string {
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
        const langLabel = codeLang ? chalk.hex(MARKDOWN_THEME.muted).italic(` ${codeLang}`) : '';
        out.push(chalk.hex(MARKDOWN_THEME.codeFence)('┌' + '─'.repeat(Math.max(2, cols - 2))) + langLabel);
        for (const cl of codeLines) {
          out.push(chalk.hex(MARKDOWN_THEME.codeFence)('│ ') + renderCodeLine(codeLang, cl));
        }
        out.push(chalk.hex(MARKDOWN_THEME.codeFence)('└' + '─'.repeat(Math.max(2, cols - 2))));
        codeLang = '';
        codeLines = [];
      }
      continue;
    }
    if (inCodeBlock) { codeLines.push(raw); continue; }

    const h1 = raw.match(/^# (.+)/);
    const h2 = raw.match(/^## (.+)/);
    const h3 = raw.match(/^### (.+)/);
    if (h1) { out.push('\n' + chalk.bold.hex(MARKDOWN_THEME.accentStrong)(h1[1]!)); continue; }
    if (h2) { out.push('\n' + chalk.bold.hex(MARKDOWN_THEME.text)(h2[1]!)); continue; }
    if (h3) { out.push(chalk.bold(h3[1]!)); continue; }

    if (/^---+$/.test(raw) || /^\*\*\*+$/.test(raw)) {
      out.push(chalk.hex(MARKDOWN_THEME.muted)('─'.repeat(cols)));
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
      out.push((bullet[1] ?? '') + chalk.hex(MARKDOWN_THEME.accent)('•') + ' ' + inlineMarkdown(bullet[2] ?? ''));
      continue;
    }

    const numbered = raw.match(/^(\s*)(\d+)\. (.+)/);
    if (numbered) {
      out.push(
        (numbered[1] ?? '') +
          chalk.hex(MARKDOWN_THEME.accent)(numbered[2]! + '.') +
          ' ' +
          inlineMarkdown(numbered[3] ?? ''),
      );
      continue;
    }

    const bq = raw.match(/^> (.+)/);
    if (bq) { out.push(chalk.hex(MARKDOWN_THEME.muted)('│ ') + chalk.italic.hex(MARKDOWN_THEME.muted)(bq[1]!)); continue; }

    out.push(inlineMarkdown(raw));
  }

  if (inCodeBlock && codeLines.length > 0) {
    out.push(chalk.hex(MARKDOWN_THEME.codeFence)('┌─'));
    for (const cl of codeLines) {
      out.push(chalk.hex(MARKDOWN_THEME.codeFence)('│ ') + renderCodeLine(codeLang, cl));
    }
    out.push(chalk.hex(MARKDOWN_THEME.codeFence)('└─'));
  }

  return out.join('\n');
}
