import blessed from 'blessed';
import { diffKind, renderMarkdown } from '../markdown.js';
import { highlightCode } from './syntax.js';
import { activeTuiTheme } from './theme.js';
import { displayWidth, truncateToDisplayWidth, wrapText } from './text-width.js';

// Bound bytes as well as entry count: streaming responses create a new key
// on every chunk, and 600 large partial answers otherwise retain megabytes.
const renderCache = new Map<string, string>();
const RENDER_CACHE_LIMIT = 600;
const RENDER_CACHE_CHARS = 2_000_000;
let cacheChars = 0;

export function resetTuiMarkdownCache(): void {
  renderCache.clear();
  cacheChars = 0;
}

export function renderTuiMarkdown(content: string, columns: number): string {
  columns = Math.max(2, Math.floor(columns));
  const cacheKey = activeTuiTheme().name + '\u0000' + columns + '\u0000' + content;
  const cached = renderCache.get(cacheKey);
  if (cached !== undefined) {
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, cached);
    return cached;
  }
  const markdown = activeTuiTheme().markdown;
  // One fence parser for partial and completed replies, including longer
  // fences enclosing Markdown examples, CRLF and tilde fences.
  const rendered = renderMarkdown(content, columns, {
    codeBlock: (lines, language, width) => {
      const renderedLines = lines.flatMap((line) => {
      const kind = /^(diff|patch)$/i.test(language) ? diffKind(line) : undefined;
      return wrapText(line, Math.max(2, width - 2)).map((part) => {
        if (kind === 'add' || kind === 'del') {
          const background = kind === 'add' ? markdown.diffAddBg : markdown.diffDelBg;
          const base = kind === 'add' ? markdown.diffAddText : markdown.diffDelText;
          return '{' + background + '-bg}{' + base + '-fg}'
            + highlightCode(part, activeTuiTheme().syntax)
            + ' '.repeat(Math.max(0, width - 2 - displayWidth(part)))
            + '{/' + base + '-fg}{/' + background + '-bg}';
        }
        if (kind === 'hunk' || kind === 'file') {
          const color = kind === 'hunk' ? markdown.accent : markdown.text;
          return '{' + color + '-fg}' + blessed.escape(part) + '{/' + color + '-fg}';
        }
        return highlightCode(part, activeTuiTheme().syntax);
      });
      });
      const label = language ? ` ${truncateToDisplayWidth(language, Math.max(0, width - 3))} ` : '';
      const top = '┌' + label + '─'.repeat(Math.max(0, width - displayWidth(label) - 1));
      const bottom = '└' + '─'.repeat(Math.max(0, width - 1));
      return [
        `{${markdown.codeFence}-fg}${top}{/${markdown.codeFence}-fg}`,
        ...renderedLines.map((line) => `{${markdown.codeFence}-fg}│ {/${markdown.codeFence}-fg}${line}`),
        `{${markdown.codeFence}-fg}${bottom}{/${markdown.codeFence}-fg}`,
      ];
    },
  });
  const size = cacheKey.length + rendered.length;
  if (size <= RENDER_CACHE_CHARS) {
    renderCache.set(cacheKey, rendered);
    cacheChars += size;
    while (renderCache.size > RENDER_CACHE_LIMIT || cacheChars > RENDER_CACHE_CHARS) {
      const key = renderCache.keys().next().value!;
      cacheChars -= key.length + renderCache.get(key)!.length;
      renderCache.delete(key);
    }
  }
  return rendered;
}

export function toolDiff(tool: string, output: string): string | undefined {
  if (tool === 'edit_file' || tool === 'write_file') {
    return output.match(/```diff\r?\n[\s\S]*?\r?\n```/)?.[0];
  }
  if (tool === 'git_diff') {
    try {
      const result = JSON.parse(output) as { diff?: unknown };
      if (typeof result.diff === 'string' && result.diff.trim()) return `\`\`\`diff\n${result.diff.trimEnd()}\n\`\`\``;
    } catch { /* Tool errors are displayed as ordinary activity. */ }
  }
  return undefined;
}
