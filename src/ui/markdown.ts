import blessed from 'blessed';
import { diffKind, renderMarkdown } from '../markdown.js';
import { highlightCode } from './syntax.js';

/** Blessed tags keep patch colors independent of Chalk's stdout/NO_COLOR detection. */
export function renderTuiMarkdown(content: string, columns: number): string {
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
        const background = kind === 'add' ? '#d9eadc' : '#f1dcdc';
        const width = (blessed as unknown as { unicode: { strWidth(text: string): number } }).unicode.strWidth(line);
        out.push(`{${background}-bg}{#25352c-fg}${highlightCode(line, true)}${' '.repeat(Math.max(0, columns - width))}{/#25352c-fg}{/${background}-bg}`);
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
  return out.join('\n');
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
