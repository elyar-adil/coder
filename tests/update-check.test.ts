import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkForUpdate,
  compareSemver,
  formatUpdateNotice,
  offerSelfUpdate,
  selfUpdate,
} from '../src/update-check.js';

function fetchReturning(version: string | null): { fetchImpl: typeof fetch; count: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (version === null) throw new Error('network down');
    return new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, count: () => calls };
}

function probeReturning(ok: boolean): typeof fetch {
  return (async () => new Response('{}', { status: ok ? 200 : 500 })) as unknown as typeof fetch;
}

describe('compareSemver', () => {
  it('orders release versions', () => {
    assert.equal(compareSemver('0.4.0', '0.4.0'), 0);
    assert.equal(compareSemver('0.5.0', '0.4.0') > 0, true);
    assert.equal(compareSemver('1.0.0', '0.9.9') > 0, true);
    assert.equal(compareSemver('0.4.10', '0.4.9') > 0, true);
  });

  it('treats prereleases as older than the release', () => {
    assert.equal(compareSemver('1.0.0-beta.1', '1.0.0') < 0, true);
    assert.equal(compareSemver('1.0.0', '1.0.0-rc.1') > 0, true);
    assert.equal(compareSemver('1.0.0-beta.2', '1.0.0-beta.1') > 0, true);
    assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta.1') < 0, true);
  });

  it('ignores a leading v and unparsable input', () => {
    assert.equal(compareSemver('v0.5.0', '0.5.0'), 0);
    assert.equal(compareSemver('not-a-version', '0.4.0'), 0);
  });
});

function spawnReturning(code: number | null): { spawnImpl: typeof spawn; commands: string[][] } {
    const commands: string[][] = [];
    const spawnImpl = ((command: string, args: string[]) => {
      commands.push([command, ...args]);
      return {
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        on: (event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'close') setImmediate(() => handler(code));
        },
        kill: () => undefined,
      } as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    return { spawnImpl, commands };
}

describe('selfUpdate', () => {
  it('installs from the China mirror first', async () => {
    const mock = spawnReturning(0);
    const result = await selfUpdate({
      registryUrl: 'https://registry.example',
      mirrorUrl: 'https://mirror.example',
      packageName: 'tokenmaw',
      version: '0.5.0',
      spawnImpl: mock.spawnImpl,
      fetchImpl: probeReturning(true),
      timeoutMs: 5_000,
      devInstall: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.registry, 'https://mirror.example');
    assert.deepEqual(mock.commands, [
      ['npm', 'install', '-g', '--no-fund', '--no-audit', '--registry', 'https://mirror.example', 'tokenmaw@0.5.0'],
    ]);
  });

  it('falls back to the default registry when the mirror is unreachable', async () => {
    const mock = spawnReturning(0);
    const probes: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      probes.push(String(input));
      const url = String(input);
      return new Response('{}', { status: url.includes('mirror') ? 500 : 200 });
    }) as unknown as typeof fetch;
    const result = await selfUpdate({
      registryUrl: 'https://registry.example',
      mirrorUrl: 'https://mirror.example',
      packageName: 'tokenmaw',
      version: '0.5.0',
      spawnImpl: mock.spawnImpl,
      fetchImpl,
      timeoutMs: 5_000,
      devInstall: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.registry, 'https://registry.example');
    assert.deepEqual(probes, [
      'https://mirror.example/tokenmaw/latest',
      'https://registry.example/tokenmaw/latest',
    ]);
  });

  it('retries the default registry when the mirror install fails', async () => {
    const mock = spawnReturning(1);
    const result = await selfUpdate({
      registryUrl: 'https://registry.example',
      mirrorUrl: 'https://mirror.example',
      packageName: 'tokenmaw',
      version: '0.5.0',
      spawnImpl: mock.spawnImpl,
      fetchImpl: probeReturning(true),
      timeoutMs: 5_000,
      devInstall: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 2);
    assert.match(result.errors[0], /mirror\.example: npm exit 1/);
    assert.match(result.errors[1], /registry\.example: npm exit 1/);
  });

  it('refuses to run for development installs', async () => {
    const previous = process.env.MAW_DEV_INSTALL;
    process.env.MAW_DEV_INSTALL = '1';
    try {
      const mock = spawnReturning(0);
      const result = await selfUpdate({
        registryUrl: 'https://registry.example',
        packageName: 'tokenmaw',
        spawnImpl: mock.spawnImpl,
        fetchImpl: probeReturning(true),
        timeoutMs: 5_000,
      });
      assert.equal(result.ok, false);
      assert.match(result.errors[0], /dev install/);
      assert.equal(mock.commands.length, 0);
    } finally {
      if (previous === undefined) delete process.env.MAW_DEV_INSTALL;
      else process.env.MAW_DEV_INSTALL = previous;
    }
  });

  it('respects MAW_NO_SELF_UPDATE', async () => {
    const previous = process.env.MAW_NO_SELF_UPDATE;
    process.env.MAW_NO_SELF_UPDATE = '1';
    try {
      const mock = spawnReturning(0);
      const result = await selfUpdate({
        registryUrl: 'https://registry.example',
        packageName: 'tokenmaw',
        spawnImpl: mock.spawnImpl,
        fetchImpl: probeReturning(true),
        timeoutMs: 5_000,
      });
      assert.equal(result.ok, false);
      assert.equal(mock.commands.length, 0);
    } finally {
      if (previous === undefined) delete process.env.MAW_NO_SELF_UPDATE;
      else process.env.MAW_NO_SELF_UPDATE = previous;
    }
  });

  it('accepts null mirrorUrl to install from the default registry only', async () => {
    const mock = spawnReturning(0);
    const result = await selfUpdate({
      registryUrl: 'https://registry.example',
      mirrorUrl: null,
      packageName: 'tokenmaw',
      version: '0.5.0',
      spawnImpl: mock.spawnImpl,
      fetchImpl: probeReturning(true),
      timeoutMs: 5_000,
      devInstall: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.registry, 'https://registry.example');
    assert.equal(mock.commands.length, 1);
  });

  it('reports unreachable probes without spawning npm', async () => {
    const mock = spawnReturning(0);
    const result = await selfUpdate({
      registryUrl: 'https://registry.example',
      mirrorUrl: null,
      packageName: 'tokenmaw',
      spawnImpl: mock.spawnImpl,
      fetchImpl: probeReturning(false),
      timeoutMs: 5_000,
      devInstall: false,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ['https://registry.example: unreachable']);
    assert.equal(mock.commands.length, 0);
  });
});

describe('promptForUpdate / offerSelfUpdate', () => {
  function streamPair(answer: string | null): { input: Readable; output: Writable; written: () => string } {
    let written = '';
    const output = new Writable({
      write(chunk: Buffer, _enc: string, cb: (error?: Error | null) => void) {
        written += String(chunk);
        cb();
      },
    });
    const input = new Readable({ read() {} });
    if (answer === null) {
      input.destroy();
    } else {
      setImmediate(() => input.emit('data', Buffer.from(`${answer}
`)));
    }
    return { input, output, written: () => written };
  }

  const notice = {
    packageName: 'tokenmaw',
    current: '0.4.0',
    latest: '0.5.0',
    updateAvailable: true,
  };

  it('accepts y and reports the mirror-first update', async () => {
    const mock = spawnReturning(0);
    const streams = streamPair('y');
    const message = await offerSelfUpdate(
      notice,
      streams.input,
      streams.output,
      {
        registryUrl: 'https://registry.example',
        mirrorUrl: 'https://mirror.example',
        packageName: 'tokenmaw',
        version: '0.5.0',
        spawnImpl: mock.spawnImpl,
        fetchImpl: probeReturning(true),
        timeoutMs: 5_000,
        devInstall: false,
      },
    );
    assert.ok(message);
    assert.match(message, /Updated tokenmaw 0\.4\.0 → 0\.5\.0/);
    assert.match(message, /mirror\.example/);
    assert.equal(mock.commands.length, 1);
  });

  it('declines n', async () => {
    const streams = streamPair('n');
    const message = await offerSelfUpdate(notice, streams.input, streams.output, { devInstall: false });
    assert.equal(message, null);
    assert.match(streams.written(), /Update now\? \[y\/N\]/);
  });

  it('declines on EOF without hanging', async () => {
    const streams = streamPair(null);
    const message = await offerSelfUpdate(notice, streams.input, streams.output);
    assert.equal(message, null);
  });

  it('skips everything for development installs', async () => {
    const previous = process.env.MAW_DEV_INSTALL;
    process.env.MAW_DEV_INSTALL = '1';
    try {
      const streams = streamPair('y');
      const message = await offerSelfUpdate(notice, streams.input, streams.output, { devInstall: true });
      assert.equal(message, null);
      assert.equal(streams.written().includes('Update now'), false);
    } finally {
      if (previous === undefined) delete process.env.MAW_DEV_INSTALL;
      else process.env.MAW_DEV_INSTALL = previous;
    }
  });
});

describe('formatUpdateNotice', () => {
  it('mentions versions and the npm install command', () => {
    const notice = formatUpdateNotice({
      packageName: 'tokenmaw',
      current: '0.4.0',
      latest: '0.5.0',
      updateAvailable: true,
    });
    assert.match(notice, /0\.4\.0 → 0\.5\.0/);
    assert.match(notice, /npm install -g tokenmaw@latest/);
  });
});

describe('checkForUpdate', () => {
  it('reports an update when npm has a newer version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coder-update-'));
    const mock = fetchReturning('0.5.0');
    const result = await checkForUpdate({
      registryUrl: 'https://registry.example',
      fetchImpl: mock.fetchImpl,
      cacheFile: join(dir, 'cache', 'update-check.json'),
    });
    assert.ok(result);
    assert.equal(result.updateAvailable, true);
    assert.equal(result.latest, '0.5.0');
  });

  it('reports no update for same or older versions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coder-update-'));
    const result = await checkForUpdate({
      registryUrl: 'https://registry.example',
      fetchImpl: fetchReturning('0.4.0').fetchImpl,
      cacheFile: join(dir, 'cache', 'update-check.json'),
    });
    assert.ok(result);
    assert.equal(result.updateAvailable, false);
  });

  it('caches the registry response for the TTL window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coder-update-'));
    const cacheFile = join(dir, 'cache', 'update-check.json');
    const mock = fetchReturning('0.5.0');
    const options = {
      registryUrl: 'https://registry.example',
      fetchImpl: mock.fetchImpl,
      cacheFile,
    };
    await checkForUpdate(options);
    await checkForUpdate(options);
    assert.equal(mock.count(), 1);
    const forced = await checkForUpdate({ ...options, force: true });
    assert.equal(mock.count(), 2);
    assert.ok(forced);
  });

  it('returns null when the registry is unreachable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coder-update-'));
    const result = await checkForUpdate({
      registryUrl: 'https://registry.example',
      fetchImpl: fetchReturning(null).fetchImpl,
      cacheFile: join(dir, 'cache', 'update-check.json'),
    });
    assert.equal(result, null);
  });

  it('respects the MAW_NO_UPDATE_CHECK opt-out', async () => {
    const previous = process.env.MAW_NO_UPDATE_CHECK;
    process.env.MAW_NO_UPDATE_CHECK = '1';
    try {
      const dir = await mkdtemp(join(tmpdir(), 'coder-update-'));
      const mock = fetchReturning('0.5.0');
      const result = await checkForUpdate({
        registryUrl: 'https://registry.example',
        fetchImpl: mock.fetchImpl,
        cacheFile: join(dir, 'cache', 'update-check.json'),
      });
      assert.equal(result, null);
      assert.equal(mock.count(), 0);
    } finally {
      if (previous === undefined) delete process.env.MAW_NO_UPDATE_CHECK;
      else process.env.MAW_NO_UPDATE_CHECK = previous;
    }
  });
});
