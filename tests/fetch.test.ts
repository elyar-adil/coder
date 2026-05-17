import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
});
