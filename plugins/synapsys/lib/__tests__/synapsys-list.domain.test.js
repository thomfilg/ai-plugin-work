'use strict';

// RED phase — Task 9 (GH-513): synapsys-list renders `domain:` line.
//
// Chosen rendering: memories with non-empty domain print a `domain:` line
// (comma-joined values). Memories with empty domain print NO domain line
// (cleaner output). This file exercises the pure formatter the script
// exports for testability.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LIST_SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'synapsys-list.js');

test('formatDomainLine: empty array returns null (no line rendered)', () => {
  const { formatDomainLine } = require(LIST_SCRIPT);
  assert.equal(typeof formatDomainLine, 'function', 'formatDomainLine is exported');
  assert.equal(formatDomainLine([]), null);
});

test('formatDomainLine: single domain renders `domain: e2e`', () => {
  const { formatDomainLine } = require(LIST_SCRIPT);
  const line = formatDomainLine(['e2e']);
  assert.ok(typeof line === 'string' && line.length > 0, 'returns a non-empty string');
  // strip ANSI codes for plain-text assertion
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /domain:\s*e2e\b/);
});

test('formatDomainLine: multi-domain joins with comma', () => {
  const { formatDomainLine } = require(LIST_SCRIPT);
  const line = formatDomainLine(['e2e', 'git']);
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /domain:\s*e2e,\s*git\b/);
});

test('formatDomainLine: leaf form `root:leaf` rendered intact', () => {
  const { formatDomainLine } = require(LIST_SCRIPT);
  const line = formatDomainLine(['e2e:flake-triage']);
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /domain:\s*e2e:flake-triage\b/);
});

test('formatDomainLine: undefined / null defensively returns null', () => {
  const { formatDomainLine } = require(LIST_SCRIPT);
  assert.equal(formatDomainLine(undefined), null);
  assert.equal(formatDomainLine(null), null);
});
