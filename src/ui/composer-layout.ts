/** Map code-point cursor positions to terminal cells, including wrapped CJK text. */
export function layoutComposer(value: string, cursor: number, width: number, measure: (text: string) => number) {
  const chars = Array.from(value);
  const rows = [''];
  const positions: Array<{ row: number; column: number }> = [];
  let row = 0;
  let column = 0;
  width = Math.max(2, width);
  for (let index = 0; index <= chars.length; index++) {
    const char = chars[index];
    const cells = char && char !== '\n' ? measure(char) : 0;
    if (column >= width || (cells > 0 && column + cells > width)) {
      rows.push(''); row++; column = 0;
    }
    positions.push({ row, column });
    if (char === undefined) break;
    if (char === '\n') { rows.push(''); row++; column = 0; }
    else { rows[row] += char; column += cells; }
  }
  return { rows, cursor: positions[Math.max(0, Math.min(cursor, chars.length))]! };
}
