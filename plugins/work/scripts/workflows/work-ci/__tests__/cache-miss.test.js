'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyCacheMiss } = require('../lib/cache-miss');

test('cache-miss with passing upstream routes to full rerun', () => {
  const result = classifyCacheMiss({
    category: 'cache-miss',
    upstreamProducerPassed: true,
  });
  assert.equal(result.needsFullRerun, true);
  assert.match(result.reason, /gh run rerun/);
  assert.doesNotMatch(result.reason, /--failed/);
});

test('cache-miss with failing upstream does not route to full rerun', () => {
  const result = classifyCacheMiss({
    category: 'cache-miss',
    upstreamProducerPassed: false,
  });
  assert.equal(result.needsFullRerun, false);
  assert.match(result.reason, /upstream/i);
});

test('non-cache-miss category does not route to full rerun', () => {
  const result = classifyCacheMiss({
    category: 'regression',
    upstreamProducerPassed: true,
  });
  assert.equal(result.needsFullRerun, false);
  assert.doesNotMatch(result.reason, /cache-miss/);
});
