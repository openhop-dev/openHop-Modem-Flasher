import assert from 'node:assert/strict';
import test from 'node:test';

import { releaseTagAtLeast } from '../lib/version.js';

test('releaseTagAtLeast compares semantic firmware release tags', () => {
  assert.equal(releaseTagAtLeast('v1.1.0', 'v1.1.0'), true);
  assert.equal(releaseTagAtLeast('v1.2.0', 'v1.1.0'), true);
  assert.equal(releaseTagAtLeast('v2.0.0', 'v1.1.0'), true);
  assert.equal(releaseTagAtLeast('v1.0.1', 'v1.1.0'), false);
  assert.equal(releaseTagAtLeast('v1.10.0', 'v1.2.0'), true);
});

test('releaseTagAtLeast accepts no minimum and rejects malformed tags', () => {
  assert.equal(releaseTagAtLeast('v1.0.1'), true);
  assert.equal(releaseTagAtLeast('main', 'v1.1.0'), false);
  assert.equal(releaseTagAtLeast('v1.1', 'v1.1.0'), false);
  assert.equal(releaseTagAtLeast('v1.1.0', 'not-a-release'), false);
});
