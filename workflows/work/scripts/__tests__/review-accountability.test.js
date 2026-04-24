'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAccountabilityEntries,
} = require('../follow-up-pr.js');

describe('buildAccountabilityEntries', () => {
  it('marks blocking comments as addressed', () => {
    const blocking = [{ id: 1, author: 'alice', body: 'Fix this bug' }];
    const nonBlocking = [];
    const entries = buildAccountabilityEntries(blocking, nonBlocking);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].disposition, 'addressed');
    assert.equal(entries[0].reason, 'Blocking comment addressed during follow-up');
  });

  it('marks deduplicated comments as addressed', () => {
    const blocking = [];
    const nonBlocking = [
      { id: 2, author: 'bob', body: 'Nit: rename var', deduplicated: true },
    ];
    const entries = buildAccountabilityEntries(blocking, nonBlocking);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].disposition, 'addressed');
    assert.equal(entries[0].reason, 'Previously addressed, re-posted after force-push');
  });

  it('marks non-blocking non-deduplicated comments as acknowledged (not deferred)', () => {
    const blocking = [];
    const nonBlocking = [
      { id: 3, author: 'carol', body: 'Consider renaming' },
    ];
    const entries = buildAccountabilityEntries(blocking, nonBlocking);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].disposition, 'acknowledged');
    assert.equal(entries[0].reason, 'Non-blocking low-priority comment');
  });

  it('truncates comment body to 120 characters', () => {
    const longBody = 'A'.repeat(200);
    const blocking = [{ id: 4, author: 'dave', body: longBody }];
    const entries = buildAccountabilityEntries(blocking, []);

    assert.equal(entries[0].comment.length, 120);
  });

  it('handles missing fields gracefully', () => {
    const blocking = [{}];
    const entries = buildAccountabilityEntries(blocking, []);

    assert.equal(entries[0].id, null);
    assert.equal(entries[0].author, 'unknown');
    assert.equal(entries[0].comment, '');
    assert.equal(entries[0].disposition, 'addressed');
  });

  it('combines blocking and non-blocking into single list', () => {
    const blocking = [{ id: 10, author: 'a', body: 'fix' }];
    const nonBlocking = [{ id: 20, author: 'b', body: 'nit' }];
    const entries = buildAccountabilityEntries(blocking, nonBlocking);

    assert.equal(entries.length, 2);
    assert.equal(entries[0].disposition, 'addressed');
    assert.equal(entries[1].disposition, 'acknowledged');
  });
});

describe('review-accountability error handling', () => {
  it('catch block in follow-up-pr.js writes to stderr on failure', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'follow-up-pr.js'),
      'utf8'
    );

    // Find the catch block after the review-accountability write
    const marker = 'review-accountability.json';
    const markerIdx = source.indexOf(marker);
    assert.ok(markerIdx > -1, 'Should contain review-accountability.json reference');

    const relevantSection = source.slice(markerIdx, markerIdx + 2000);
    assert.ok(
      relevantSection.includes('process.stderr.write'),
      'Catch block should write warnings to stderr'
    );
    assert.ok(
      relevantSection.includes('follow_up'),
      'Warning should mention follow_up → ci transition gate'
    );
  });
});
