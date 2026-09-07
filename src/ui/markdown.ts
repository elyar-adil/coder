import blessed from 'blessed';
import { diffKind, renderMarkdown } from '../markdown.js';
import { highlightCode } from './syntax.js';

// Historical messages re-render on every frame; memoize the (expensive) result.
// Entries are keyed by content+width and evicted least-recently-used.
const renderCache = new Map<string, string>();
const RENDER_CACHE_LIMIT = 600;

/** Blessed tags keep patch colors independent of Chalk's stdout/NO_COLOR detection. */
export function renderTuiMarkdown(content: string, columns: number): string {
  const cacheKey = `${columns}\u0000${content}`;
  const cached = renderCache.get(cacheKey);
  if (cached !== undefined) {
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, cached);
    return cached;
  }
  const out: string[] = [];
  let prose: string[] = [];
  let diff = false;
  let otherCode = false;
  const flush = () => {
    if (prose.length) out.push(blessed.escape(renderMarkdown(prose.join('\n'), columns)));
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
        const background = kind === 'add' ? '#10281a' : '#2b1215';
        const base = kind === 'add' ? '#9fd0a6' : '#d99f9f';
        const width = (blessed as unknown as { unicode: { strWidth(text: string): number } }).unicode.strWidth(line);
        out.push(`{${background}-bg}{${base}-fg}${highlightCode(line)}${' '.repeat(Math.max(0, columns - width))}{/${base}-fg}{/${background}-bg}`);
      } else {
        const color = kind === 'hunk' ? 'cyan' : 'white';
        out.push(`{${color}-fg}${kind === 'context' ? highlightCode(line) : blessed.escape(line)}{/${color}-fg}`);
      }
    } else {
      if (/^```/.test(line)) { flush(); otherCode = !otherCode; }
      else if (otherCode) out.push(highlightCode(line));
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
