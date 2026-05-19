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

  for (const raw of lines) {
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
          if (codeLang === 'diff') {
            const color = cl.startsWith('+') ? chalk.hex(MARKDOWN_THEME.codeGreen)
              : cl.startsWith('-') ? chalk.hex(MARKDOWN_THEME.codeRed)
              : cl.startsWith('@') ? chalk.hex(MARKDOWN_THEME.accent)
              : chalk.hex(MARKDOWN_THEME.muted);
            out.push(chalk.hex(MARKDOWN_THEME.codeFence)('│ ') + color(cl));
          } else {
            out.push(chalk.hex(MARKDOWN_THEME.codeFence)('│ ') + chalk.hex(MARKDOWN_THEME.codeText)(cl));
          }
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
    for (const cl of codeLines) out.push(chalk.hex(MARKDOWN_THEME.codeFence)('│ ') + (codeLang === 'diff' ? (cl.startsWith('+') ? chalk.hex(MARKDOWN_THEME.codeGreen)(cl) : cl.startsWith('-') ? chalk.hex(MARKDOWN_THEME.codeRed)(cl) : chalk.hex(MARKDOWN_THEME.muted)(cl)) : chalk.hex(MARKDOWN_THEME.codeText)(cl)));
    out.push(chalk.hex(MARKDOWN_THEME.codeFence)('└─'));
  }

  return out.join('\n');
}
