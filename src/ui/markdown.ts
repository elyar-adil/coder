import blessed from 'blessed';
import { diffKind, renderMarkdown } from '../markdown.js';
import { highlightCode } from './syntax.js';
import { activeTuiTheme } from './theme.js';

// Historical messages re-render on every frame; memoize the (expensive) result.
// Entries are keyed by theme+width+content and evicted least-recently-used.
const renderCache = new Map<string, string>();
const RENDER_CACHE_LIMIT = 600;

export function resetTuiMarkdownCache(): void {
  renderCache.clear();
}

/** Blessed tags keep patch colors independent of Chalk's stdout/NO_COLOR detection. */
export function renderTuiMarkdown(content: string, columns: number): string {
  const cacheKey = `${activeTuiTheme().name}\u0000${columns}\u0000${content}`;
  const cached = renderCache.get(cacheKey);
  if (cached !== undefined) {
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, cached);
    return cached;
  }
  const markdown = activeTuiTheme().markdown;
  const out: string[] = [];
  let prose: string[] = [];
  let diff = false;
  let otherCode = false;
  const flush = () => {
    if (prose.length) out.push(renderMarkdown(prose.join('\n'), columns));
    prose = [];
  };
  for (const line of content.split('\n')) {
    if (!diff && !otherCode && /^```(?:diff|patch)\s*$/.test(line)) {
      flush(); diff = true;
    } else if (diff && /^```\s*$/.test(line)) {
      diff = false;
    } else if (diff) {
      const kind = diffKind(line);
      if (kind === 'add' || kind === 'del') {
        // Deep, near-black tinted backgrounds keep the code readable while
        // still signaling added/removed lines.
        const background = kind === 'add' ? markdown.diffAddBg : markdown.diffDelBg;
        const base = kind === 'add' ? markdown.diffAddText : markdown.diffDelText;
        const width = (blessed as unknown as { unicode: { strWidth(text: string): number } }).unicode.strWidth(line);
        out.push(`{${background}-bg}{${base}-fg}${highlightCode(line, activeTuiTheme().syntax)}${' '.repeat(Math.max(0, columns - width))}{/${base}-fg}{/${background}-bg}`);
      } else if (kind === 'hunk') {
        out.push(`{${markdown.accent}-fg}${blessed.escape(line)}{/${markdown.accent}-fg}`);
      } else if (kind === 'file') {
        out.push(`{${markdown.text}-fg}${blessed.escape(line)}{/${markdown.text}-fg}`);
      } else {
        out.push(highlightCode(line, activeTuiTheme().syntax));
      }
    } else {
      if (/^```/.test(line)) { flush(); otherCode = !otherCode; }
      else if (otherCode) out.push(highlightCode(line, activeTuiTheme().syntax));
      else prose.push(line);
    }
  }
  flush();
  const rendered = out.join('\n');
  renderCache.set(cacheKey, rendered);
  if (renderCache.size > RENDER_CACHE_LIMIT) {
    renderCache.delete(renderCache.keys().next().value!);
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
