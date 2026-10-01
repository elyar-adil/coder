import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { REDACTED, SecretRedactor, collectConfigSecrets } from '../src/infra/redact.js';
import { AgentRuntimeStore } from '../src/runtime/agent-store.js';

const KEY = 'sk-test-1234567890abcdefghij';

describe('SecretRedactor', () => {
  test('replaces every occurrence of a known key, raw and JSON-escaped', () => {
    const redactor = new SecretRedactor();
    redactor.add('pa"ss\\word-123456');
    const text = JSON.stringify({ a: 'pa"ss\\word-123456', b: ['x pa"ss\\word-123456 y'] });
    const out = redactor.redactJson(text);
    assert.doesNotMatch(out, /word-123456/);
    assert.deepEqual(JSON.parse(out), { a: REDACTED, b: [`x ${REDACTED} y`] });
  });

  test('replaces the longest key first when one contains another', () => {
    const redactor = new SecretRedactor();
    redactor.add('abcdefgh', 'abcdefgh-and-more');
    assert.equal(redactor.redactJson('k=abcdefgh-and-more'), `k=${REDACTED}`);
  });

  test('ignores values too short or with whitespace to be a key', () => {
    const redactor = new SecretRedactor();
    redactor.add('short', undefined, '   ', 'has some spaces in it');
    assert.equal(redactor.size, 0);
    assert.equal(redactor.redactJson('short has some spaces in it'), 'short has some spaces in it');
  });

  test('environment values count only when the name says secret and the value looks generated', () => {
    const redactor = new SecretRedactor();
    redactor.addEnv({
      OPENAI_API_KEY: 'zk9Qw3Lm8Vb2Nc7XyRt5',
      DEPLOY_ENV_SECRET: 'production-environment',
      GITHUB_TOKEN: 'short1',
      PATH: '/usr/local/bin:/usr/bin:/bin:/opt/some/long/path',
      HOME_DIRECTORY_TOKEN: 'onlylowercaseletters',
    });
    assert.equal(redactor.size, 1, 'only the generated-looking API key qualifies');
    assert.equal(redactor.redactJson('key zk9Qw3Lm8Vb2Nc7XyRt5, env production-environment'), `key ${REDACTED}, env production-environment`);
  });

  test('recognizes unmistakable key formats without registration', () => {
    const redactor = new SecretRedactor();
    const samples = [
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx',
      `sk-${'a1'.repeat(20)}`,
      `ghp_${'A'.repeat(36)}`,
      'github_pat_11ABCDEFG0abcdefghijkl_xyz',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-abcdefghij',
      `AIza${'B'.repeat(35)}`,
    ];
    for (const sample of samples) assert.equal(redactor.redactJson(`token=${sample};`), `token=${REDACTED};`, sample);
  });

  test('redacts a whole PEM private key even though JSON stores its newlines as \\n', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----';
    const out = new SecretRedactor().redactJson(JSON.stringify({ output: `before\n${pem}\nafter` }));
    assert.doesNotMatch(out, /MIIBOgIBAAJ/);
    assert.deepEqual(JSON.parse(out), { output: `before\n${REDACTED}\nafter` });
  });

  test('does not touch ordinary text or near-miss strings', () => {
    const text = 'sk-short ghp_tooshort AKIA123 the task is to rotate the key';
    assert.equal(new SecretRedactor().redactJson(text), text);
  });
});

describe('collectConfigSecrets', () => {
  test('gathers top-level, provider, and legacy per-model keys', () => {
    assert.deepEqual(collectConfigSecrets({
      apiKey: 'top',
      providers: { a: { apiKey: 'prov-a' }, b: {} },
      models: { m: { apiKey: 'legacy' }, n: {} },
    }).sort(), ['legacy', 'prov-a', 'top']);
    assert.deepEqual(collectConfigSecrets({}), []);
  });
});

describe('AgentRuntimeStore', () => {
  test('never writes a registered key into a session snapshot or a compaction archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maw-redact-'));
    try {
      const store = new AgentRuntimeStore(root);
      await store.init();
      store.redactor.add(KEY);
      const snapshot = {
        version: 1,
        session: { sessionId: 's1', messages: [{ role: 'assistant', content: `the key is ${KEY}` }] },
        instances: [{ messages: [{ role: 'tool', content: `cat .agentrc -> {"apiKey":"${KEY}"}` }] }],
      };
      await store.save(snapshot as never);
      const saved = await readFile(store.sessionPath('s1'), 'utf8');
      assert.doesNotMatch(saved, /1234567890abcdefghij/);
      assert.match(saved, /\[REDACTED\]/);
      assert.equal((await store.load('s1'))?.session.sessionId, 's1', 'the redacted file is still a valid session');

      await store.saveArchive('s1', 'main', 1, [{ role: 'tool', content: `leaked ${KEY}` }]);
      const archives = await store.loadArchives('s1');
      assert.equal(JSON.stringify(archives).includes('1234567890abcdefghij'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
