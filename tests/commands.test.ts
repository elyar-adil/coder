import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandMatches, SLASH_COMMANDS } from '../src/ui/commands.js';

test('slash suggestions filter command prefixes and stop after arguments begin', () => {
  assert.equal(commandMatches('/').length, SLASH_COMMANDS.length);
  assert.deepEqual(commandMatches('/mo').map((item) => item.name), ['/model', '/mouse']);
  assert.deepEqual(commandMatches('/unknown'), []);
  assert.deepEqual(commandMatches('/model luna'), []);
  assert.deepEqual(commandMatches('hello /'), []);
});
