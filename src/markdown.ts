/**
 * markdown.ts — Lightweight terminal markdown renderer.
 *
 * Exported so it can be unit-tested independently of the TUI.
 * No external dependencies — pure string transformation.
 */

import chalk from 'chalk';

export function inlineMarkdown(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, (_m, t: string) => chalk.bold.italic(t))
    .replace(/\*\*(.+?)\*\*/g,     (_m, t: string) => chalk.bold(t))
    .replace(/__(.+?)__/g,         (_m, t: string) => chalk.bold(t))
    .replace(/\*(.+?)\*/g,         (_m, t: string) => chalk.italic(t))
    .replace(/_(.+?)_/g,           (_m, t: string) => chalk.italic(t))
    .replace(/`([^`]+)`/g,         (_m, t: string) => chalk.bgBlack.greenBright(` ${t} `))
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
        const langLabel = codeLang ? chalk.dim.italic(` ${codeLang}`) : '';
        out.push(chalk.dim('┌' + '─'.repeat(Math.max(2, cols - 2))) + langLabel);
        for (const cl of codeLines) out.push(chalk.dim('│ ') + chalk.greenBright(cl));
        out.push(chalk.dim('└' + '─'.repeat(Math.max(2, cols - 2))));
        codeLang = '';
        codeLines = [];
      }
      continue;
    }
    if (inCodeBlock) { codeLines.push(raw); continue; }

    const h1 = raw.match(/^# (.+)/);
    const h2 = raw.match(/^## (.+)/);
    const h3 = raw.match(/^### (.+)/);
    if (h1) { out.push('\n' + chalk.bold.cyan(h1[1]!)); continue; }
    if (h2) { out.push('\n' + chalk.bold.white(h2[1]!)); continue; }
    if (h3) { out.push(chalk.bold(h3[1]!)); continue; }

    if (/^---+$/.test(raw) || /^\*\*\*+$/.test(raw)) {
      out.push(chalk.dim('─'.repeat(cols)));
      continue;
    }

    const bullet = raw.match(/^(\s*)[*\-+] (.+)/);
    if (bullet) {
      out.push((bullet[1] ?? '') + chalk.cyan('•') + ' ' + inlineMarkdown(bullet[2] ?? ''));
      continue;
    }

    const numbered = raw.match(/^(\s*)(\d+)\. (.+)/);
    if (numbered) {
      out.push(
        (numbered[1] ?? '') +
          chalk.cyan(numbered[2]! + '.') +
          ' ' +
          inlineMarkdown(numbered[3] ?? ''),
      );
      continue;
    }

    const bq = raw.match(/^> (.+)/);
    if (bq) { out.push(chalk.dim('│ ') + chalk.italic.dim(bq[1]!)); continue; }

    out.push(inlineMarkdown(raw));
  }

  if (inCodeBlock && codeLines.length > 0) {
    out.push(chalk.dim('┌─'));
    for (const cl of codeLines) out.push(chalk.dim('│ ') + chalk.greenBright(cl));
    out.push(chalk.dim('└─'));
  }

  return out.join('\n');
}
