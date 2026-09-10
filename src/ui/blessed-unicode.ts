/**
 * Blessed 0.1.x predates most emoji and reports astral emoji as one column.
 * Terminals render them in two columns, so Blessed's incremental renderer
 * leaves the second cell stale. This is particularly visible when a line
 * begins with an emoji: every subsequent screen update repaints the stale
 * cell and makes the line appear to flicker.
 */
type BlessedUnicode = {
  charWidth: (value: string | number, index?: number) => number;
  codePointAt: (value: string, index?: number) => number;
};

const EMOJI_START = 0x1F000;
const EMOJI_END = 0x1FAFF;

function emojiCodePoint(value: string | number, index?: number): number {
  if (typeof value === 'number') return value;
  return value.codePointAt(index ?? 0) ?? 0;
}

/** Install the missing two-column width rule without changing non-emoji text. */
export function installBlessedEmojiWidthSupport(unicode: BlessedUnicode): void {
  const originalCharWidth = unicode.charWidth;
  // The module singleton is shared by every Blessed screen, so avoid wrapping
  // it again when a TUI is opened after a previous one closes.
  if ((originalCharWidth as { emojiWidthPatched?: boolean }).emojiWidthPatched) return;

  const patchedCharWidth = (value: string | number, index?: number): number => {
    const codePoint = emojiCodePoint(value, index);
    if (codePoint >= EMOJI_START && codePoint <= EMOJI_END) return 2;
    return originalCharWidth(value, index);
  };
  (patchedCharWidth as { emojiWidthPatched?: boolean }).emojiWidthPatched = true;
  unicode.charWidth = patchedCharWidth;
}
