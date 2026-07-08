/**
 * Tests for factories/runtime/tickets.js — the shared ticket-providers.json
 * key helpers — plus the cross-plugin parity contract: work's
 * ticket-provider.js and maestro's ticket-prefix.js must normalize remote
 * URLs byte-identically (both consume their vendored runtime/tickets.js;
 * the providers file written by one plugin is read back by the other).
 *
 * Run: node --test factories/runtime/__tests__/tickets.spec.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { normalizeRemoteUrl, remoteOriginKey } = require('../tickets');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const ticketProvider = require(
  path.join(REPO_ROOT, 'plugins', 'work', 'scripts', 'workflows', 'lib', 'ticket-provider.js')
);
const ticketPrefix = require(
  path.join(REPO_ROOT, 'plugins', 'maestro', 'scripts', 'lib', 'ticket-prefix.js')
);

// Shared fixture table: [input, expected providers-file key].
const NORMALIZE_FIXTURES = [
  ['git@github.com:Org/Repo.git', 'github.com/org/repo'],
  ['git@github.com:org/repo', 'github.com/org/repo'],
  ['https://github.com/org/repo.git', 'github.com/org/repo'],
  ['http://github.com/Org/Repo', 'github.com/org/repo'],
  ['https://gitlab.com/group/sub/project.git', 'gitlab.com/group/sub/project'],
  ['git@bitbucket.org:Team/Repo.git', 'bitbucket.org/team/repo'],
  ['ssh://git@github.com/org/repo.git', 'ssh///git@github.com/org/repo'],
  ['', null],
  [null, null],
  [undefined, null],
];

describe('normalizeRemoteUrl fixture table', () => {
  for (const [input, expected] of NORMALIZE_FIXTURES) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      assert.equal(normalizeRemoteUrl(input), expected);
    });
  }
});

describe('cross-plugin parity — work ↔ maestro ↔ master', () => {
  it('both plugins expose normalizeRemoteUrl', () => {
    assert.equal(typeof ticketProvider.normalizeRemoteUrl, 'function');
    assert.equal(typeof ticketPrefix.normalizeRemoteUrl, 'function');
  });

  for (const [input, expected] of NORMALIZE_FIXTURES) {
    it(`all three agree on ${JSON.stringify(input)}`, () => {
      assert.equal(ticketProvider.normalizeRemoteUrl(input), expected);
      assert.equal(ticketPrefix.normalizeRemoteUrl(input), expected);
    });
  }
});

describe('remoteOriginKey', () => {
  it('returns the normalized origin key inside this repo', () => {
    const key = remoteOriginKey(REPO_ROOT);
    // The repo may have any origin URL locally; assert the invariant shape
    // rather than a hardcoded remote: normalized keys are lowercase and
    // never carry a scheme or trailing .git.
    if (key !== null) {
      assert.equal(key, key.toLowerCase());
      assert.doesNotMatch(key, /^https?:\/\//);
      assert.doesNotMatch(key, /\.git$/);
    }
  });

  it('returns null outside a git repo', () => {
    assert.equal(remoteOriginKey('/'), null);
  });
});
