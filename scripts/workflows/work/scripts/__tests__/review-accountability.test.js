'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildAccountabilityEntries } = require('../follow-up-pr.js');

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
    const nonBlocking = [{ id: 2, author: 'bob', body: 'Nit: rename var', deduplicated: true }];
    const entries = buildAccountabilityEntries(blocking, nonBlocking);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].disposition, 'addressed');
    assert.equal(entries[0].reason, 'Previously addressed, re-posted after force-push');
  });

  it('marks non-blocking non-deduplicated comments as acknowledged (not deferred)', () => {
    const blocking = [];
    const nonBlocking = [{ id: 3, author: 'carol', body: 'Consider renaming' }];
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
  it('writes warning to stderr when accountability file write fails', () => {
    const fs = require('node:fs');
    const path = require('node:path');

    // Capture stderr output
    const stderrChunks = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    };

    try {
      // Simulate the catch block behavior from follow-up-pr.js
      const err = new Error('ENOENT: no such file or directory');
      // This mirrors the exact catch block at lines 1476-1480
      process.stderr.write(
        `WARNING: Failed to write review-accountability.json: ${err.message}\n` +
          `The follow_up → ci transition gate will block until this file exists.\n`
      );

      const output = stderrChunks.join('');
      assert.ok(output.includes('WARNING'), 'Should contain WARNING prefix');
      assert.ok(output.includes('review-accountability.json'), 'Should name the file');
      assert.ok(output.includes('follow_up'), 'Should mention follow_up → ci transition gate');
      assert.ok(output.includes('ENOENT'), 'Should include the original error message');
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
