'use strict';

/**
 * Tests for the shared `(NEW)` / `(DELETE)` scope-marker normaliser, plus the
 * guard that keeps every consumer on it. The underlying bug (GH-725 class) has
 * been fixed independently three times with three private regexes; the guard
 * test at the bottom is what stops a fourth copy appearing.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stripScopeMarker, normalizeScope, stripScopeMarkersInText } = require('../scope-markers');

const WORKFLOWS = path.resolve(__dirname, '..', '..');
const PLUGIN_WORK = path.resolve(WORKFLOWS, '..', '..');

describe('stripScopeMarker — one scope entry', () => {
  it('strips (NEW) and (DELETE) in any casing', () => {
    assert.equal(
      stripScopeMarker('components/ui/sparkline/** (NEW)'),
      'components/ui/sparkline/**'
    );
    assert.equal(stripScopeMarker('lib/old.ts (DELETE)'), 'lib/old.ts');
    assert.equal(stripScopeMarker('lib/a.ts (new)'), 'lib/a.ts');
    assert.equal(stripScopeMarker('lib/b.ts (delete)'), 'lib/b.ts');
    assert.equal(stripScopeMarker('lib/c.ts   (NEW)   '), 'lib/c.ts');
  });

  it('leaves an unmarked entry untouched', () => {
    assert.equal(
      stripScopeMarker('components/shell/sidebar/sidebar.tsx'),
      'components/shell/sidebar/sidebar.tsx'
    );
  });

  it('does NOT strip a marker mid-entry — that is malformed input, not an annotation', () => {
    // Anchored on purpose: silently repairing this would hide the authoring
    // error while still yielding a path that cannot resolve.
    assert.equal(stripScopeMarker('lib/(NEW)/thing.ts'), 'lib/(NEW)/thing.ts');
  });

  it('tolerates non-string input without throwing', () => {
    assert.equal(stripScopeMarker(42), '42');
  });
});

describe('normalizeScope — a scope list', () => {
  it('strips every entry and drops the empties', () => {
    assert.deepEqual(normalizeScope(['a.ts (NEW)', '', 'b.ts', '  ', 'c.ts (DELETE)']), [
      'a.ts',
      'b.ts',
      'c.ts',
    ]);
  });

  it('treats null/undefined as an empty list', () => {
    assert.deepEqual(normalizeScope(null), []);
    assert.deepEqual(normalizeScope(undefined), []);
  });
});

describe('stripScopeMarkersInText — free prose', () => {
  it('strips every occurrence, not just a trailing one', () => {
    assert.equal(
      stripScopeMarkersInText('a.ts (NEW) and b.ts (DELETE) ship together'),
      'a.ts and b.ts ship together'
    );
  });

  it('collapses each marker to a space so adjacent tokens do not fuse', () => {
    assert.equal(stripScopeMarkersInText('a.ts (NEW) b.ts'), 'a.ts b.ts');
  });
});

describe('every consumer routes through this module (no private copies)', () => {
  // The three sites that historically each grew their own regex.
  const CONSUMERS = [
    path.join(WORKFLOWS, 'task-verify', 'observe.js'),
    path.join(WORKFLOWS, 'work-implement', 'tdd-phase-state', 'active-task.js'),
    path.join(PLUGIN_WORK, 'skills', 'split-in-tasks', 'lib', 'lint-type-ac-consistency.js'),
  ];

  // A literal marker pattern written into a regex — what a fourth copy looks like.
  const PRIVATE_MARKER_RE = /\/[^/\n]*\\\(\s*\(\?:\s*(?:NEW|DELETE)/i;

  for (const file of CONSUMERS) {
    const rel = path.relative(PLUGIN_WORK, file);

    it(`${rel} imports the shared normaliser`, () => {
      const src = fs.readFileSync(file, 'utf8');
      assert.match(
        src,
        /require\([^)]*scope-markers[^)]*\)/,
        `${rel} must require lib/scope-markers instead of re-deriving the pattern`
      );
    });

    it(`${rel} defines no private marker regex`, () => {
      const src = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(
        src,
        PRIVATE_MARKER_RE,
        `${rel} appears to define its own (NEW)/(DELETE) regex — use lib/scope-markers`
      );
    });
  }
});
