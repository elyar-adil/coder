export function unifiedDiff(filePath: string, before: string, after: string, maxChangedLines = 160): string {
  if (before === after) return '';
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start += 1;
  }

  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;
  while (beforeEnd >= start && afterEnd >= start && beforeLines[beforeEnd] === afterLines[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const contextBeforeStart = Math.max(0, start - 3);
  const contextAfterEnd = Math.min(afterLines.length - 1, afterEnd + 3);
  const lines = [
    '```diff',
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -${contextBeforeStart + 1} +${contextBeforeStart + 1} @@`,
  ];

  for (const line of beforeLines.slice(contextBeforeStart, start)) {
    lines.push(` ${line}`);
  }

  const removed = beforeLines.slice(start, beforeEnd + 1);
  const added = afterLines.slice(start, afterEnd + 1);
  const changed = [
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  if (changed.length > maxChangedLines) {
    lines.push(...changed.slice(0, maxChangedLines));
    lines.push(` ... ${changed.length - maxChangedLines} more changed lines`);
  } else {
    lines.push(...changed);
  }

  for (const line of afterLines.slice(afterEnd + 1, contextAfterEnd + 1)) {
    lines.push(` ${line}`);
  }

  lines.push('```');
  return lines.join('\n');
}
