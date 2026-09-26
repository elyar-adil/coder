import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { FetchError, resilientFetch } from '../src/fetch.js';

describe('FetchError', () => {
  it('stores status and retriable flag', () => {
    const err = new FetchError('test', 500, true);
    assert.equal(err.message, 'test');
    assert.equal(err.status, 500);
    assert.equal(err.retriable, true);
    assert.equal(err.name, 'FetchError');
  });

  it('allows null status for network errors', () => {
    const err = new FetchError('ECONNREFUSED', null, true);
    assert.equal(err.status, null);
    assert.equal(err.retriable, true);
  });
});

describe('resilientFetch', () => {
  it('throws FetchError for non-retriable HTTP errors', async () => {
    try {
      await resilientFetch('http://localhost:1/invalid', { retries: 0, timeout: 2000 });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof FetchError);
    }
  });

  it('throws FetchError with retries=0 for immediate failure', async () => {
    try {
      await resilientFetch('http://localhost:1/immediate-fail', { retries: 0, timeout: 1000 });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof FetchError);
      assert.equal(err.retriable, true);
    }
  });

  it('honors a Retry-After header over exponential backoff', async () => {
    let requestsHit = 0;
    const requests: Server = createServer((req, res) => {
      if (requestsHit++ === 0) {
        // Advertise zero wait: a compliant client retries immediately, while
        // the exponential fallback would have slept `retryDelay` (5s here).
        res.writeHead(429, { 'retry-after': '0' });
        res.end('rate limited');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    requests.listen(0, '127.0.0.1');
    await once(requests, 'listening');
    const url = `http://127.0.0.1:${(requests.address() as { port: number }).port}/chat`;
    try {
      const startedAt = Date.now();
      const response = await resilientFetch(url, { retries: 2, retryDelay: 5000, timeout: 2000 });
      const elapsed = Date.now() - startedAt;
      assert.equal(response.status, 200);
      assert.ok(elapsed < 2000, `Retry-After: 0 must retry immediately, took ${elapsed}ms (exponential would wait 5000ms)`);
    } finally {
      requests.close();
      requests.closeAllConnections?.();
    }
  });

  it('carries Retry-After on the exhausted FetchError', async () => {
    const always429: Server = createServer((req, res) => {
      res.writeHead(429, { 'retry-after': '0' });
      res.end('rate limited');
    });
    always429.listen(0, '127.0.0.1');
    await once(always429, 'listening');
    const url = `http://127.0.0.1:${(always429.address() as { port: number }).port}/chat`;
    try {
      await resilientFetch(url, { retries: 0, timeout: 2000 });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof FetchError);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterMs, 0);
    } finally {
      always429.close();
      always429.closeAllConnections?.();
    }
  });
});
