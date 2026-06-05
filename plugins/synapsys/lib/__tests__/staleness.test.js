'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { hashFile, classifyMemory, groupResultsBySource, summarise } = require('../staleness');

const repoRoot = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'sample-repo');
const docARel = 'docs/a.md';
const docBRel = 'docs/b.md';
const docCRel = 'docs/c.md'; // intentionally absent

function sha256OfFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

const knownHashA = sha256OfFile(path.join(repoRoot, docARel));

test('hashFile returns sha256:<64-hex> for an existing file', () => {
  const result = hashFile(path.join(repoRoot, docARel));
  assert.match(result, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result, knownHashA);
});

test('hashFile returns null for a missing file', () => {
  const result = hashFile(path.join(repoRoot, 'docs', 'does-not-exist.md'));
  assert.equal(result, null);
});

test('CASE 1 — fresh memory when stored hash matches current source hash', () => {
  const memory = {
    name: 'mem-a.md',
    meta: { source: docARel, source_hash: knownHashA },
  };
  const result = classifyMemory(memory, { repoRoot });
  assert.equal(result.status, 'fresh');
  assert.equal(result.current_hash, knownHashA);
  assert.equal(result.stored_hash, knownHashA);
  assert.equal(result.current_hash, result.stored_hash);
});

test('CASE 2 — drifted memory reports both stored and current hashes', () => {
  const mutated = 'sha256:' + 'a'.repeat(64);
  const memory = {
    name: 'mem-a.md',
    meta: { source: docARel, source_hash: mutated },
  };
  const result = classifyMemory(memory, { repoRoot });
  assert.equal(result.status, 'drifted');
  assert.equal(result.stored_hash, mutated);
  assert.equal(result.current_hash, knownHashA);
  assert.notEqual(result.current_hash, result.stored_hash);
  assert.ok(result.stored_hash);
  assert.ok(result.current_hash);
});

test('CASE 3 — orphan memory when source file is missing', () => {
  const memory = {
    name: 'mem-c.md',
    meta: { source: docCRel, source_hash: 'sha256:' + 'b'.repeat(64) },
  };
  const result = classifyMemory(memory, { repoRoot });
  assert.equal(result.status, 'orphan');
  assert.equal(result.current_hash, null);
});

test('CASE 4 — manual memory without source_hash is silently skipped', () => {
  const memory = {
    name: 'manual.md',
    meta: {
      /* no source_hash, possibly no source */
    },
  };
  const result = classifyMemory(memory, { repoRoot });
  assert.equal(result.status, 'skip');
});

test('classifyMemory classifies path-traversal source as orphan', () => {
  const memory = {
    name: 'evil.md',
    meta: { source: '../../etc/passwd', source_hash: 'sha256:' + 'c'.repeat(64) },
  };
  const result = classifyMemory(memory, { repoRoot });
  assert.equal(result.status, 'orphan');
  assert.equal(result.current_hash, null);
});

test('groupResultsBySource groups by source, sorts memories asc, and filters skip', () => {
  const storedA = 'sha256:' + '1'.repeat(64);
  const storedB = 'sha256:' + '2'.repeat(64);
  const currentA = 'sha256:' + '3'.repeat(64);
  const classifications = [
    // Two memories share docARel (drifted) — memories must sort asc.
    {
      name: 'zeta.md',
      status: 'drifted',
      source: docARel,
      stored_hash: storedA,
      current_hash: currentA,
    },
    {
      name: 'alpha.md',
      status: 'drifted',
      source: docARel,
      stored_hash: storedA,
      current_hash: currentA,
    },
    // Orphan with its own source
    {
      name: 'orph.md',
      status: 'orphan',
      source: docCRel,
      stored_hash: storedB,
      current_hash: null,
    },
    // Fresh with docBRel
    {
      name: 'mid.md',
      status: 'fresh',
      source: docBRel,
      stored_hash: storedB,
      current_hash: storedB,
    },
    // skip must be filtered
    { name: 'manual.md', status: 'skip' },
  ];
  const grouped = groupResultsBySource(classifications);
  assert.ok(Array.isArray(grouped));
  assert.equal(grouped.length, 3, 'three source groups (skip filtered)');
  // No skip groups
  assert.equal(
    grouped.find((g) => g.status === 'skip'),
    undefined
  );

  const docAGroup = grouped.find((g) => g.source === docARel);
  assert.ok(docAGroup, 'docA group exists');
  assert.equal(docAGroup.status, 'drifted');
  assert.equal(docAGroup.stored_hash, storedA);
  assert.equal(docAGroup.current_hash, currentA);
  assert.deepEqual(docAGroup.memories, ['alpha.md', 'zeta.md']);

  const docCGroup = grouped.find((g) => g.source === docCRel);
  assert.ok(docCGroup);
  assert.equal(docCGroup.status, 'orphan');
  assert.deepEqual(docCGroup.memories, ['orph.md']);

  const docBGroup = grouped.find((g) => g.source === docBRel);
  assert.ok(docBGroup);
  assert.equal(docBGroup.status, 'fresh');
  assert.deepEqual(docBGroup.memories, ['mid.md']);
});

test('summarise returns drifted/orphan/fresh counts plus totalAffectedMemories and fresh_memories', () => {
  const storedA = 'sha256:' + '1'.repeat(64);
  const storedB = 'sha256:' + '2'.repeat(64);
  const storedC = 'sha256:' + '4'.repeat(64);
  const currentA = 'sha256:' + '3'.repeat(64);
  const grouped = [
    {
      source: 'docs/a.md',
      status: 'drifted',
      stored_hash: storedA,
      current_hash: currentA,
      memories: ['alpha.md', 'zeta.md'],
    },
    {
      source: 'docs/b.md',
      status: 'fresh',
      stored_hash: storedB,
      current_hash: storedB,
      memories: ['mid.md'],
    },
    {
      source: 'docs/c.md',
      status: 'orphan',
      stored_hash: storedC,
      current_hash: null,
      memories: ['orph.md'],
    },
    {
      source: 'docs/d.md',
      status: 'fresh',
      stored_hash: storedB,
      current_hash: storedB,
      memories: ['delta.md', 'echo.md'],
    },
  ];
  const summary = summarise(grouped);
  assert.equal(summary.drifted, 1);
  assert.equal(summary.orphan, 1);
  assert.equal(summary.fresh, 2);
  // totalAffectedMemories counts memories under drifted + orphan groups (alpha, zeta, orph = 3)
  assert.equal(summary.totalAffectedMemories, 3);
  // fresh_memories counts memories under fresh groups (mid, delta, echo = 3)
  assert.equal(summary.fresh_memories, 3);
});
