import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function extractSingleBlock(html: string, tag: 'script' | 'style'): string {
  const pattern = tag === 'script'
    ? /<script>([\s\S]*?)<\/script>/g
    : /<style>([\s\S]*?)<\/style>/g;
  const matches = [...html.matchAll(pattern)];
  assert.equal(matches.length, 1, `expected one inline ${tag} block`);
  return matches[0]![1]!;
}

function assertBalancedCss(css: string): void {
  let depth = 0;
  let line = 1;
  for (const char of css) {
    if (char === '\n') line += 1;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      assert.ok(depth >= 0, `extra CSS closing brace near line ${line}`);
    }
  }
  assert.equal(depth, 0, 'unclosed CSS block');
}

describe('web static assets', () => {
  it('keeps the single page app CSS and JS syntactically valid', async () => {
    const html = await readFile(resolve('src/ui/public/index.html'), 'utf8');
    assertBalancedCss(extractSingleBlock(html, 'style'));
    assert.doesNotThrow(() => new Function(extractSingleBlock(html, 'script')));
  });
});
