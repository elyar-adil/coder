import { readFile, stat } from 'node:fs/promises';

/**
 * Reading files for the model. Three things must never flood the context:
 * binary content decoded as text, a file too large to read whole, and one
 * enormous line (a minified bundle). Each is turned into a short, actionable
 * message or a bounded window instead.
 */

/** Refuse to load files beyond this; they need search_text or a shell. */
export const MAX_READ_BYTES = 10 * 1024 * 1024;
/** Without an explicit limit, show at most this many lines ... */
export const DEFAULT_WINDOW_LINES = 2_000;
/** ... and about this many characters, whichever comes first. */
export const DEFAULT_WINDOW_CHARS = 20_000;
/** Longer lines are shortened in the listing. */
export const MAX_LINE_CHARS = 2_000;

const BINARY_PROBE_BYTES = 8_000;

export function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, BINARY_PROBE_BYTES);
  return probe.includes(0);
}

export type TextRead = { ok: true; content: string } | { ok: false; message: string };

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

/** Read a file as UTF-8 text, or explain why it cannot usefully be read as text. */
export async function readTextFile(path: string, label = path): Promise<TextRead> {
  const info = await stat(path);
  if (info.isDirectory()) return { ok: false, message: `${label} is a directory; use list_dir.` };
  if (info.size > MAX_READ_BYTES) {
    return {
      ok: false,
      message: `${label} is ${humanSize(info.size)}, too large to read whole. Use search_text to find what you need, or a shell command such as head, tail, or sed -n 'START,ENDp'.`,
    };
  }
  const buffer = await readFile(path);
  if (looksBinary(buffer)) {
    return {
      ok: false,
      message: `${label} looks like a binary file (${humanSize(info.size)}), not text. Inspect it with a shell command (file, xxd, strings) if you need to.`,
    };
  }
  return { ok: true, content: buffer.toString('utf8') };
}

export interface LineWindowOptions {
  /** 1-based first line. */
  offset?: number;
  /** Explicit line count; when set the default size window is not applied. */
  limit?: number;
}

function shortenLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} … [+${line.length - MAX_LINE_CHARS} chars on this line]` : line;
}

/**
 * Number the lines of `raw` and bound the listing. With no explicit `limit`,
 * show a window of at most DEFAULT_WINDOW_LINES lines / DEFAULT_WINDOW_CHARS
 * characters and say where to continue, so the model never sees a listing cut
 * off mid-way by a later hard truncation.
 */
export function formatLineWindow(raw: string, options: LineWindowOptions = {}): string {
  if (raw === '') return '';
  const allLines = raw.split('\n');
  const totalLines = allLines.length;
  const startLine = Math.max(1, Math.min(options.offset ?? 1, totalLines));

  let endLine: number;
  if (options.limit !== undefined) {
    endLine = Math.min(startLine + Math.max(1, options.limit) - 1, totalLines);
  } else {
    let chars = 0;
    endLine = startLine - 1;
    while (endLine < totalLines && endLine - startLine + 1 < DEFAULT_WINDOW_LINES) {
      const cost = Math.min(allLines[endLine]!.length, MAX_LINE_CHARS) + 7;
      if (endLine >= startLine && chars + cost > DEFAULT_WINDOW_CHARS) break;
      chars += cost;
      endLine += 1;
    }
  }

  const numbered = allLines.slice(startLine - 1, endLine).map((line, index) => (
    `${String(startLine + index).padStart(5, '0')}|${shortenLine(line)}`
  )).join('\n');
  return endLine < totalLines
    ? `${numbered}\n... (showing lines ${startLine}-${endLine} of ${totalLines}; use offset/limit to read more)`
    : numbered;
}
