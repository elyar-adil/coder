import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveConfiguredPath, resolveDownloadPath, safeDownloadName } from '../src/web.js';

describe('web artifact downloads', () => {
  it('uses basename-only download names', () => {
    assert.equal(safeDownloadName('/Users/demo/coder/coder_presentation.pptx'), 'coder_presentation.pptx');
    assert.equal(safeDownloadName('/tmp/bad"name\n.pptx'), 'bad_name_.pptx');
  });

  it('resolves configured artifact paths from the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'coder-web-workspace-'));
    try {
      assert.equal(
        resolveConfiguredPath('.agent-workspace/artifacts', workspace, 'fallback'),
        resolve(workspace, '.agent-workspace/artifacts'),
      );
      assert.equal(resolveConfiguredPath('/tmp/coder-artifacts', workspace, 'fallback'), '/tmp/coder-artifacts');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('finds files in the current session artifact directory before workspace fallbacks', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'coder-web-workspace-'));
    try {
      const artifactRoot = join(workspace, '.agent-workspace', 'artifacts');
      const sessionArtifactDir = join(artifactRoot, 'session-1');
      await mkdir(sessionArtifactDir, { recursive: true });
      await writeFile(join(workspace, 'report.pptx'), 'workspace', 'utf8');
      await writeFile(join(sessionArtifactDir, 'report.pptx'), 'session', 'utf8');

      assert.equal(
        resolveDownloadPath('report.pptx', { workspaceRoot: workspace, artifactRoot, sessionArtifactDir }),
        join(sessionArtifactDir, 'report.pptx'),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects traversal outside allowed roots', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'coder-web-workspace-'));
    const external = await mkdtemp(join(tmpdir(), 'coder-web-external-'));
    try {
      const artifactRoot = join(workspace, '.agent-workspace', 'artifacts');
      const sessionArtifactDir = join(artifactRoot, 'session-1');
      await mkdir(sessionArtifactDir, { recursive: true });
      const outside = join(external, 'report.pptx');
      await writeFile(outside, 'outside', 'utf8');

      assert.equal(
        resolveDownloadPath(outside, { workspaceRoot: workspace, artifactRoot, sessionArtifactDir }),
        undefined,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });
});
