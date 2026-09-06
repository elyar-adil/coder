/** A quiet, static wordmark. Center against the window, not its scrollback. */
export function renderWelcome(width: number, height: number, terminalHeight = height, frame = 0): string[] {
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  const rows = Array.from({ length: height }, () => '');
  const wordmark = width >= 9 ? 'C O D E R' : 'CODER'.slice(0, width);
  const center = Math.max(0, Math.min(height - 1, Math.floor((terminalHeight - 1) / 2)));
  const left = ' '.repeat(Math.max(0, Math.floor((width - wordmark.length) / 2)));
  rows[center] = `${left}{white-fg}{bold}${wordmark}{/bold}{/white-fg}`;
  if (center + 2 < height && width >= 9) {
    // A four-second, eased breath in one subdued hue, with a slight spatial
    // falloff. No discrete moving cell or white flash at the turning points.
    const breath = (1 - Math.cos((frame % 80) / 80 * Math.PI * 2)) / 2;
    const rule = [0, 1, 2].map((index) => {
      const intensity = breath * (index === 1 ? 1 : 0.85);
      const low = [48, 66, 72];
      const high = [91, 135, 146];
      const color = '#' + low.map((value, channel) => Math.round(value + (high[channel]! - value) * intensity).toString(16).padStart(2, '0')).join('');
      return `{${color}-fg}─{/${color}-fg}`;
    }).join('');
    rows[center + 2] = `${' '.repeat(Math.floor((width - 3) / 2))}${rule}`;
  }
  return rows;
}
