export interface MarkdownFence {
  marker: string;
  length: number;
  language: string;
}

export function openingFence(line: string): MarkdownFence | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[2]![0] === '`' && match[3]!.includes('`'))) return;
  return { marker: match[2]![0]!, length: match[2]!.length, language: match[3]!.trim().split(/\s+/)[0] ?? '' };
}

export function closesFence(line: string, fence: MarkdownFence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return Boolean(match && match[1]![0] === fence.marker && match[1]!.length >= fence.length);
}
