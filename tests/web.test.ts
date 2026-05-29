import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, get, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveConfiguredPath, resolveDownloadPath, safeDownloadName, shutdownWebServer } from '../src/web.js';

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

  it('shuts down cleanly with an open SSE client', async () => {
    const clients = new Map<string, { id: string; res: ServerResponse }>();
    let unsubscribed = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.set('c1', { id: 'c1', res });
    });

    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const ended = new Promise<void>((resolveEnd, reject) => {
      const req = get({ host: '127.0.0.1', port: address.port, path: '/api/events' }, (res) => {
        res.resume();
        res.on('end', resolveEnd);
      });
      req.on('error', reject);
    });

    await new Promise<void>((resolveClient) => {
      const started = Date.now();
      const poll = (): void => {
        if (clients.size > 0) { resolveClient(); return; }
        if (Date.now() - started > 1000) throw new Error('SSE client was not registered');
        setTimeout(poll, 10);
      };
      poll();
    });

    await shutdownWebServer(server, clients, () => { unsubscribed = true; }, 50);
    await ended;

    assert.equal(unsubscribed, true);
    assert.equal(clients.size, 0);
  });
});
