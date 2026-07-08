'use strict';

// GH-519 review ("Config max_keywords not applied"): SessionStart keyword
// derivation must pass `config.max_keywords` (the documented cortex_auto_recall
// YAML knob) to deriveKeywords, instead of always using the hardcoded default
// cap. buildSessionQueries threads it through.

const test = require('node:test');
const assert = require('node:assert/strict');

const cortexHook = require('../lib/cortex-hook');
const cortexRecall = require('../lib/cortex-recall');

function withStubbedDerive(fn) {
  const prevKw = process.env.SYNAPSYS_CORTEX_KEYWORDS;
  const origDerive = cortexRecall.deriveKeywords;
  let receivedOpts;
  try {
    // Force the derivation path (the env override short-circuits deriveKeywords).
    delete process.env.SYNAPSYS_CORTEX_KEYWORDS;
    cortexRecall.deriveKeywords = (_args, opts) => {
      receivedOpts = opts;
      return ['kw'];
    };
    fn();
  } finally {
    cortexRecall.deriveKeywords = origDerive;
    if (prevKw === undefined) delete process.env.SYNAPSYS_CORTEX_KEYWORDS;
    else process.env.SYNAPSYS_CORTEX_KEYWORDS = prevKw;
  }
  return receivedOpts;
}

test('buildSessionQueries: passes maxKeywords when config.max_keywords is set', () => {
  const received = withStubbedDerive(() => {
    cortexHook.buildSessionQueries('/tmp/cortex-cwd', { max_keywords: 3 });
  });
  assert.ok(received, 'deriveKeywords was called with an opts object');
  assert.equal(received.maxKeywords, 3, 'config.max_keywords is threaded as maxKeywords');
});

test('buildSessionQueries: omits maxKeywords when config has none (deriveKeywords default applies)', () => {
  const received = withStubbedDerive(() => {
    cortexHook.buildSessionQueries('/tmp/cortex-cwd', {});
  });
  assert.deepEqual(received, {}, 'no maxKeywords forced when config omits it');
});
