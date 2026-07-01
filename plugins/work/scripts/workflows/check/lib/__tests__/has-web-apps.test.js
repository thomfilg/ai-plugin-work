'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let hasWebApps;
try {
  ({ hasWebApps } = require('../has-web-apps'));
} catch {
  // Module not yet implemented (RED phase) — assertions below will fail.
  hasWebApps = () => undefined;
}

test('returns false when impactedApps is an empty array', () => {
  assert.equal(hasWebApps([], { WEB_APPS: 'app' }), false);
});

test('returns false when env.WEB_APPS is unset', () => {
  assert.equal(hasWebApps(['app'], {}), false);
});

test('returns false when env.WEB_APPS is an empty string', () => {
  assert.equal(hasWebApps(['app'], { WEB_APPS: '' }), false);
});

test('returns true when impactedApps is non-empty AND env.WEB_APPS is a non-empty string', () => {
  assert.equal(hasWebApps(['app'], { WEB_APPS: '["app"]' }), true);
});

test('returns false for null impactedApps (defensive)', () => {
  assert.equal(hasWebApps(null, { WEB_APPS: 'app' }), false);
});

test('returns false for undefined impactedApps (defensive)', () => {
  assert.equal(hasWebApps(undefined, { WEB_APPS: 'app' }), false);
});

test('returns false for null/undefined env (defensive)', () => {
  assert.equal(hasWebApps(['app'], null), false);
  assert.equal(hasWebApps(['app'], undefined), false);
});
