// WP-09 — lib/ticket-prefix.js: the vendored, read-only projectKey resolver
// resolve-prefix.sh shells into. Must mirror ticket-provider.getProviderConfig
// semantics (env → providers file keyed by normalized remote → JIRA legacy →
// null) WITHOUT reaching into ../../../work/ (cache installs isolate plugins).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const TICKET_PREFIX_LIB = path.resolve(__dirname, '..', 'lib', 'ticket-prefix.js');
const ticketPrefix = require(TICKET_PREFIX_LIB);

const ENV_KEYS = ['TICKET_PROVIDER', 'TICKET_PROJECT_KEY', 'JIRA_PROJECT_KEY', 'LINEAR_TEAM_ID'];

function withEnv(env, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('TICKET_PROVIDER env drives the config (linear/jira keys, github empty, none bare)', () => {
  withEnv({ TICKET_PROVIDER: 'linear', TICKET_PROJECT_KEY: 'ECHO' }, () => {
    assert.equal(ticketPrefix.getProviderConfig({ skipPrompt: true }).projectKey, 'ECHO');
  });
  withEnv({ TICKET_PROVIDER: 'jira', JIRA_PROJECT_KEY: 'APP' }, () => {
    assert.equal(ticketPrefix.getProviderConfig({ skipPrompt: true }).projectKey, 'APP');
  });
  withEnv({ TICKET_PROVIDER: 'github' }, () => {
    const cfg = ticketPrefix.getProviderConfig({ skipPrompt: true });
    assert.equal(cfg.provider, 'github');
    assert.equal(cfg.projectKey, '');
  });
  withEnv({ TICKET_PROVIDER: 'none' }, () => {
    assert.equal(ticketPrefix.getProviderConfig({ skipPrompt: true }).projectKey, undefined);
  });
});

test('JIRA_PROJECT_KEY legacy fallback applies without TICKET_PROVIDER', () => {
  withEnv({ JIRA_PROJECT_KEY: 'LEG' }, () => {
    // cwd pinned to a non-repo dir so no ticket-providers.json remote entry
    // can shadow the legacy leg on developer machines.
    const cfg = ticketPrefix.getProviderConfig({ skipPrompt: true, cwd: '/' });
    assert.equal(cfg.provider, 'jira');
    assert.equal(cfg.projectKey, 'LEG');
  });
});

test('invalid provider values fall through instead of fabricating a config', () => {
  withEnv({ TICKET_PROVIDER: 'gitlab' }, () => {
    assert.equal(ticketPrefix.getProviderConfig({ skipPrompt: true, cwd: '/' }), null);
  });
});

test('normalizeRemoteUrl matches ticket-provider.js key normalization', () => {
  assert.equal(
    ticketPrefix.normalizeRemoteUrl('git@github.com:Org/Repo.git'),
    'github.com/org/repo'
  );
  assert.equal(
    ticketPrefix.normalizeRemoteUrl('https://github.com/org/repo.git'),
    'github.com/org/repo'
  );
  assert.equal(ticketPrefix.normalizeRemoteUrl(''), null);
});

test('resolve-prefix.sh sources the vendored helper, not ../../../work/', () => {
  const sh = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'resolve-prefix.sh'), 'utf8');
  // The runtime path assignment must point at the vendored helper; the old
  // cross-plugin path may only survive in comments (provenance note).
  assert.match(sh, /provider_js="\$script_dir\/ticket-prefix\.js"/);
  assert.doesNotMatch(sh, /provider_js=.*\.\.\/work\//);
});
