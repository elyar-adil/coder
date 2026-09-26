import stripAnsi from 'strip-ansi';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const zeroWidth = /^[\p{Mark}\p{Cf}\p{Cc}]*$/u;
const emoji = /\p{Emoji_Presentation}|\uFE0F|\u20E3/u;

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), ({ segment }) => segment);
}

export function graphemeWidth(text: string): number {
  if (!text || zeroWidth.test(text)) return 0;
  if (emoji.test(text)) return 2;
  const point = text.codePointAt(0)!;
  return point >= 0x1100 && (
    point <= 0x115f || point === 0x2329 || point === 0x232a
    || (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f)
    || (point >= 0xac00 && point <= 0xd7a3)
    || (point >= 0xf900 && point <= 0xfaff)
    || (point >= 0xfe10 && point <= 0xfe19)
    || (point >= 0xfe30 && point <= 0xfe6f)
    || (point >= 0xff00 && point <= 0xff60)
    || (point >= 0xffe0 && point <= 0xffe6)
    || (point >= 0x20000 && point <= 0x3fffd)
  ) ? 2 : 1;
}

/** Plain text width. Literal braces (code, JSON, paths) are real cells. */
export function displayWidth(text: string): number {
  return graphemes(stripAnsi(text)).reduce((width, part) => width + graphemeWidth(part), 0);
}

export function truncateToDisplayWidth(text: string, maxWidth: number): string {
  const limit = Math.max(0, Math.floor(maxWidth));
  if (!limit) return '';
  if (displayWidth(text) <= limit) return text;
  let out = '';
  let width = 0;
  for (const part of graphemes(text)) {
    const size = graphemeWidth(part);
    if (width + size > limit - 1) break;
    out += part;
    width += size;
  }
  return out + '…';
}

/** Hard-wrap code without losing content or splitting a grapheme. */
export function wrapText(text: string, columns: number): string[] {
  const limit = Math.max(2, Math.floor(columns));
  const rows = [''];
  let width = 0;
  for (const part of graphemes(text.replace(/\t/g, '    '))) {
    const size = graphemeWidth(part);
    if (width + size > limit) { rows.push(''); width = 0; }
    rows[rows.length - 1] += part;
    width += size;
  }
  return rows;
}

/** Style tags and escaped literal braces must be decoded in a single pass. */
export function stripTerminalFormatting(text: string): string {
  return stripAnsi(text).replace(/\{[^{}]*\}/g, (tag) => tag === '{open}' ? '{' : tag === '{close}' ? '}' : '');
}

export function styledWidth(text: string): number {
  return displayWidth(stripTerminalFormatting(text));
}

/** Clip rendered inline Markdown, retaining its style resets after the cut. */
export function truncateStyled(text: string, columns: number): string {
  const limit = Math.max(0, Math.floor(columns));
  if (!limit) return '';
  if (styledWidth(text) <= limit) return text;
  let width = 0;
  let clipped = false;
  let result = '';
  for (const token of text.split(/(\{[^{}]*\}|\x1b\[[\d;]*m)/g)) {
    if (!token) continue;
    if ((token.startsWith('{') && token !== '{open}' && token !== '{close}') || token.startsWith('\x1b')) {
      result += token;
      continue;
    }
    const parts = token === '{open}' || token === '{close}' ? [token] : graphemes(token);
    for (const part of parts) {
      const size = part === '{open}' || part === '{close}' ? 1 : graphemeWidth(part);
      if (!clipped && width + size <= limit - 1) { result += part; width += size; }
      else if (!clipped) { result += '…'; clipped = true; }
    }
  }
  return result;
}
