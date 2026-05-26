/**
 * Tests for lib/related-tickets.js
 *
 * Run: node --test scripts/workflows/lib/__tests__/related-tickets.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const rt = require('../related-tickets');

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-tickets-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const validManifest = () => ({
  self: { id: 'GH-279', title: 'x', status: 'In Progress' },
  parent: { id: 'GH-200', title: 'p', status: 'Open' },
  siblings: [{ id: 'GH-280', title: 's', status: 'Done', prNumber: 1508, surfaces: ['lib/a.ts'] }],
  blockedBy: [],
  dependsOn: [],
  relatedTo: [{ id: 'GH-100', status: 'Done', prNumber: 999 }],
  fetchedAt: new Date().toISOString(),
});

describe('manifestPath', () => {
  it('joins tasksDir + ARTIFACT_FILENAME', () => {
    const p = rt.manifestPath('/tmp/xyz', path);
    assert.equal(p, path.join('/tmp/xyz', 'related-tickets.json'));
  });
});

describe('validate', () => {
  it('accepts a fully valid manifest', () => {
    const { valid, errors } = rt.validate(validManifest());
    assert.equal(valid, true, errors.join('; '));
    assert.deepEqual(errors, []);
  });

  it('rejects non-object input', () => {
    assert.equal(rt.validate(null).valid, false);
    assert.equal(rt.validate('hi').valid, false);
    assert.equal(rt.validate(42).valid, false);
  });

  it('requires self.id', () => {
    const m = validManifest();
    delete m.self.id;
    const { valid, errors } = rt.validate(m);
    assert.equal(valid, false);
    assert.match(errors.join('|'), /self\.id/);
  });

  it('allows parent: null', () => {
    const m = validManifest();
    m.parent = null;
    assert.equal(rt.validate(m).valid, true);
  });

  it('rejects parent without id', () => {
    const m = validManifest();
    m.parent = { title: 'no id here' };
    assert.equal(rt.validate(m).valid, false);
  });

  it('rejects missing siblings array', () => {
    const m = validManifest();
    delete m.siblings;
    const { valid, errors } = rt.validate(m);
    assert.equal(valid, false);
    assert.match(errors.join('|'), /siblings.*array/);
  });

  it('rejects sibling without id', () => {
    const m = validManifest();
    m.siblings.push({ title: 'no id' });
    assert.equal(rt.validate(m).valid, false);
  });

  it('rejects bad fetchedAt', () => {
    const m = validManifest();
    m.fetchedAt = 'not a date';
    assert.equal(rt.validate(m).valid, false);
  });

  it('accepts empty link arrays', () => {
    const m = validManifest();
    m.siblings = [];
    m.relatedTo = [];
    assert.equal(rt.validate(m).valid, true);
  });
});

describe('read / readAndValidate', () => {
  it('returns null when file missing', () => {
    assert.equal(rt.read(tmpDir, { fs, path }), null);
  });

  it('readAndValidate flags missing file', () => {
    const r = rt.readAndValidate(tmpDir, { fs, path });
    assert.equal(r.missing, true);
    assert.equal(r.valid, false);
  });

  it('readAndValidate flags invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'related-tickets.json'), '{not json');
    const r = rt.readAndValidate(tmpDir, { fs, path });
    assert.equal(r.missing, false);
    assert.equal(r.valid, false);
    assert.match(r.errors.join('|'), /JSON/);
  });

  it('readAndValidate flags schema errors', () => {
    fs.writeFileSync(path.join(tmpDir, 'related-tickets.json'), JSON.stringify({ self: {} }));
    const r = rt.readAndValidate(tmpDir, { fs, path });
    assert.equal(r.valid, false);
    assert.ok(r.errors.length > 0);
  });

  it('readAndValidate accepts valid manifest on disk', () => {
    fs.writeFileSync(path.join(tmpDir, 'related-tickets.json'), JSON.stringify(validManifest()));
    const r = rt.readAndValidate(tmpDir, { fs, path });
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
    assert.ok(r.manifest);
  });
});

describe('isStale', () => {
  it('treats missing fetchedAt as stale', () => {
    assert.equal(rt.isStale(null, new Date()), true);
    assert.equal(rt.isStale({}, new Date()), true);
  });

  it('returns true when fetchedAt < runStartedAt', () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    assert.equal(rt.isStale({ fetchedAt: old }, new Date()), true);
  });

  it('returns false when fetchedAt >= runStartedAt', () => {
    const start = new Date(Date.now() - 60_000);
    const fresh = new Date().toISOString();
    assert.equal(rt.isStale({ fetchedAt: fresh }, start), false);
  });

  it('handles ISO string for runStartedAt', () => {
    const start = new Date(Date.now() - 60_000).toISOString();
    const fresh = new Date().toISOString();
    assert.equal(rt.isStale({ fetchedAt: fresh }, start), false);
  });
});

describe('siblingIds', () => {
  it('returns [] for null', () => {
    assert.deepEqual(rt.siblingIds(null), []);
  });

  it('flattens unique IDs across parent + siblings + linkages', () => {
    const m = validManifest();
    m.blockedBy = [{ id: 'GH-200' }]; // duplicate of parent
    const ids = rt.siblingIds(m);
    assert.deepEqual(ids.sort(), ['GH-100', 'GH-200', 'GH-280']);
  });
});

describe('siblingSurfaces', () => {
  it('returns [] for null', () => {
    assert.deepEqual(rt.siblingSurfaces(null), []);
  });

  it('collects unique surfaces across parent + siblings + linkages', () => {
    const m = validManifest();
    m.parent.surfaces = ['lib/parent.ts', 'lib/a.ts']; // 'lib/a.ts' duplicate of sibling
    m.blockedBy = [{ id: 'GH-X', surfaces: ['app/x.ts'] }];
    const surfaces = rt.siblingSurfaces(m);
    assert.deepEqual(surfaces.sort(), ['app/x.ts', 'lib/a.ts', 'lib/parent.ts']);
  });

  it('ignores non-string surface entries', () => {
    const m = validManifest();
    m.siblings[0].surfaces = ['ok.ts', 42, null, '', 'other.ts'];
    assert.deepEqual(rt.siblingSurfaces(m).sort(), ['ok.ts', 'other.ts']);
  });
});
