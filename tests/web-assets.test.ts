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

function extractFunctionBlock(script: string, name: string): string {
  const start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = script.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < script.length; i += 1) {
    const char = script[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return script.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function loadMarkdownTableHelpers(script: string): (text: string) => string {
  const names = [
    'markdownTableCells',
    'isMarkdownTableRow',
    'isMarkdownTableSeparator',
    'markdownTableSeparator',
    'isInsideOpenFence',
    'normalizeStreamingMarkdownTables',
  ];
  const source = `${names.map(name => extractFunctionBlock(script, name)).join('\n')}\nreturn normalizeStreamingMarkdownTables;`;
  return new Function(source)() as (text: string) => string;
}

describe('web static assets', () => {
  it('keeps the single page app CSS and JS syntactically valid', async () => {
    const html = await readFile(resolve('src/ui/public/index.html'), 'utf8');
    assertBalancedCss(extractSingleBlock(html, 'style'));
    assert.doesNotThrow(() => new Function(extractSingleBlock(html, 'script')));
  });

  it('normalizes trailing streaming markdown table fragments before marked parses them', async () => {
    const html = await readFile(resolve('src/ui/public/index.html'), 'utf8');
    const normalize = loadMarkdownTableHelpers(extractSingleBlock(html, 'script'));

    assert.equal(
      normalize('| Name | Value |'),
      '| Name | Value |\n| --- | --- |',
    );
    assert.equal(
      normalize('| Name | Value |\n|---|'),
      '| Name | Value |\n| --- | --- |',
    );
    assert.equal(
      normalize('```\n| Name | Value |'),
      '```\n| Name | Value |',
    );
  });


  it('requires explicit download markers and keeps chips filename-only', async () => {
    const html = await readFile(resolve('src/ui/public/index.html'), 'utf8');
    const script = extractSingleBlock(html, 'script');

    assert.match(script, /DOWNLOAD_MARKER_RE/);
    assert.match(script, /function replaceDownloadMarkers/);
    assert.match(script, /function isDownloadMarkerPath/);
    assert.doesNotMatch(script, /AUTO_FILE_RE/);
    assert.doesNotMatch(script, /looksLikeDownloadableFile/);
    assert.doesNotMatch(script, /<span>Download<\/span>/);
    assert.match(script, /<code>\$\{escHtml\(text\)\}<\/code><\/a>`/);
  });

  it('labels task card output and assistant messages with the concrete task agent', async () => {
    const html = await readFile(resolve('src/ui/public/index.html'), 'utf8');
    const script = extractSingleBlock(html, 'script');

    assert.match(script, /function taskAgentLabel/);
    assert.match(script, /taskAgentLabel\(task, 'Agent'\)/);
    assert.match(script, /task-output-source/);
    assert.match(script, /setTaskCardOutput\(event\.taskId, event\.result\)/);
  });
  it('updates writer patch cards by patch id instead of appending duplicates', async () => {
    const html = await readFile(resolve('src/ui/public/index.html'), 'utf8');
    const script = extractSingleBlock(html, 'script');
    assert.match(script, /data-patch-id/);
    assert.match(script, /patchDiffMarkdown/);
  });
});
