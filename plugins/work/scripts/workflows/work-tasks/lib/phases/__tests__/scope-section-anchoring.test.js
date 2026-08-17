'use strict';

/**
 * `### Files in scope` is matched only as a real heading.
 *
 * kind_assign and scope_exists both used an unanchored
 * `/###\s+Files in scope[^\n]*\n([\s\S]*?)(?=\n###\s|\n## |$(?![\s\S]))/`.
 * A backticked mention in ordinary prose — "- Document the
 * `### Files in scope` convention" — matched as the heading, and the capture
 * then ran from that AC bullet up to the REAL heading, so the parsed file list
 * came back empty. kind_assign rejected the task for listing no `*.test.*`
 * entry when its scope plainly listed one.
 *
 * `work/lib/task-parser.js` already guards against this and documents why;
 * `_scope-section.js` shares that helper with both gates.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const kindAssign = require(path.resolve(__dirname, '..', 'kind_assign.js'));
const scopeExists = require(path.resolve(__dirname, '..', 'scope_exists.js'));
const { matchScopeSection } = require(path.resolve(__dirname, '..', '_scope-section.js'));

/** A task whose AC quotes the heading before the real section appears. */
const INLINE_MENTION = [
  '## Task 1 — sample',
  '',
  '### Type',
  'tdd-code',
  '',
  '### Acceptance Criteria',
  '- Document the `### Files in scope` convention in the contributor guide',
  '',
  '### Files in scope',
  '- `lib/x/writer.ts`',
  '- `lib/x/writer.test.ts`',
  '',
  '### Files explicitly out of scope',
  '- `lib/other.ts`',
  '',
].join('\n');

describe('matchScopeSection', () => {
  it('skips a backticked heading mentioned mid-line', () => {
    const m = matchScopeSection(INLINE_MENTION, 'Files in scope');
    assert.ok(m, 'expected the real section to match');
    assert.match(m[1], /lib\/x\/writer\.ts/);
    assert.match(m[1], /lib\/x\/writer\.test\.ts/);
    assert.doesNotMatch(m[1], /contributor guide/);
  });

  it('returns null for an absent heading, and for non-string input', () => {
    assert.equal(matchScopeSection('## Task 1\n\n### Type\ntdd-code\n', 'Files in scope'), null);
    assert.equal(matchScopeSection(null, 'Files in scope'), null);
    assert.equal(matchScopeSection('', 'Files in scope'), null);
  });

  it('keeps the last line of a section that has no trailing newline', () => {
    const m = matchScopeSection('### Files in scope\n- `a.ts`\n- `b.ts`', 'Files in scope');
    assert.match(m[1], /b\.ts/);
  });
});

// Adding the start-of-line anchor must not narrow anything else. Borrowing
// `work/lib/task-parser.js`'s helper wholesale did exactly that: it interpolates
// a literal heading line, so `###  Files in scope` (two spaces) and a tab both
// stopped matching — producing the very "lists no `*.test.*` file" false
// rejection this module exists to prevent — and its `\n###` terminator began
// truncating a section at a `#### Sub-heading`.
describe('matchScopeSection tolerates the same heading shapes as before', () => {
  const scope = ['- `lib/x/writer.ts`', '- `lib/x/writer.test.ts`'];
  const build = (heading, extra = []) =>
    ['## Task 1', '', '### Type', 'tdd-code', '', heading, ...scope, ...extra, ''].join('\n');

  for (const [label, heading] of [
    ['one space', '### Files in scope'],
    ['two spaces', '###  Files in scope'],
    ['a tab', '###\tFiles in scope'],
    ['trailing text', '### Files in scope (globs)'],
  ]) {
    it(`matches a heading separated by ${label}`, () => {
      assert.deepEqual(kindAssign.parseBlocks(build(heading))[0].filesInScope, [
        'lib/x/writer.ts',
        'lib/x/writer.test.ts',
      ]);
    });
  }

  it('does not truncate the section at a #### sub-heading', () => {
    const body = build('### Files in scope', ['', '#### Notes', '- `lib/x/extra.ts`']);
    assert.deepEqual(kindAssign.parseBlocks(body)[0].filesInScope, [
      'lib/x/writer.ts',
      'lib/x/writer.test.ts',
      'lib/x/extra.ts',
    ]);
  });

  it('still terminates at the next ### section', () => {
    const body = build('### Files in scope', ['', '### Acceptance Criteria', '- does the thing']);
    assert.deepEqual(kindAssign.parseBlocks(body)[0].filesInScope, [
      'lib/x/writer.ts',
      'lib/x/writer.test.ts',
    ]);
  });
});

describe('kind_assign parses the real scope section', () => {
  it('does not truncate the list to nothing on an inline heading mention', () => {
    const blocks = kindAssign.parseBlocks(INLINE_MENTION);
    assert.deepEqual(blocks[0].filesInScope, ['lib/x/writer.ts', 'lib/x/writer.test.ts']);
    assert.deepEqual(blocks[0].filesOutOfScope, ['lib/other.ts']);
  });

  it('so a tdd-code task listing a test file is not rejected for lacking one', () => {
    const { filesInScope } = kindAssign.parseBlocks(INLINE_MENTION)[0];
    assert.ok(
      filesInScope.some((f) => /\.test\./.test(f)),
      `expected a test entry in ${JSON.stringify(filesInScope)}`
    );
  });
});

describe('scope_exists parses the real scope section', () => {
  it('does not truncate the entry list on an inline heading mention', () => {
    const [block] = scopeExists.parseTaskBlocks(INLINE_MENTION);
    assert.deepEqual(
      block.entries.map((e) => e.path),
      ['lib/x/writer.ts', 'lib/x/writer.test.ts']
    );
  });

  it('still reads markers off the real section', () => {
    const withMarkers = INLINE_MENTION.replace(
      '- `lib/x/writer.test.ts`',
      '- `lib/x/writer.test.ts` (NEW)'
    );
    const [block] = scopeExists.parseTaskBlocks(withMarkers);
    assert.deepEqual(
      block.entries.map((e) => e.marker),
      [null, 'NEW']
    );
  });
});
