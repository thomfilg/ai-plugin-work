'use strict';

// GH-534 Task 1 — TriggerTokens shared library.
// The library lives at plugins/synapsys/lib/shared/trigger-tokens.js and
// exposes five primitives consumed by both the GH-440 crystallize lint
// (import-only swap) and the new GH-534 `synapsys lint` binary.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE_PATH = path.resolve(__dirname, '..', 'trigger-tokens');
const {
  extractAlternationTokens,
  tokenizeBody,
  triggerMatchesBody,
  pretoolArgSets,
  jaccard,
} = require(MODULE_PATH);

// ---------- extractAlternationTokens ----------

test('extractAlternationTokens returns lowercase tokens from a single alternation group', () => {
  const out = extractAlternationTokens('\\b(release|version|publish)\\b');
  assert.deepEqual(out, ['release', 'version', 'publish']);
});

test('extractAlternationTokens lowercases mixed-case tokens', () => {
  const out = extractAlternationTokens('\\b(Release|VERSION)\\b');
  assert.deepEqual(out, ['release', 'version']);
});

test('extractAlternationTokens skips parens without a pipe', () => {
  const out = extractAlternationTokens('\\b(release)\\b');
  assert.deepEqual(out, []);
});

test('extractAlternationTokens skips non-word tokens inside alternation', () => {
  const out = extractAlternationTokens('\\b(release|\\s+|publish)\\b');
  assert.deepEqual(out, ['release', 'publish']);
});

test('extractAlternationTokens returns [] for empty / non-string input', () => {
  assert.deepEqual(extractAlternationTokens(''), []);
  assert.deepEqual(extractAlternationTokens(null), []);
  assert.deepEqual(extractAlternationTokens(undefined), []);
  assert.deepEqual(extractAlternationTokens(42), []);
});

test('extractAlternationTokens handles multiple parenthesised groups', () => {
  const out = extractAlternationTokens('(foo|bar).*(baz|qux)');
  assert.deepEqual(out, ['foo', 'bar', 'baz', 'qux']);
});

// ---------- tokenizeBody ----------

test('tokenizeBody returns lowercased word tokens of length >= 2', () => {
  const out = tokenizeBody('Slack handoff before clipboard paste');
  // "slack" / "paste" are STOP_WORDS so they get filtered out.
  assert.ok(out.includes('handoff'));
  assert.ok(out.includes('before'));
  assert.ok(out.includes('clipboard'));
  assert.ok(!out.includes('slack'));
  assert.ok(!out.includes('paste'));
});

test('tokenizeBody filters STOP_WORDS', () => {
  const out = tokenizeBody('test tests vitest commit branch alpha bravo');
  // All but alpha/bravo are stop words.
  assert.deepEqual(out.sort(), ['alpha', 'bravo']);
});

test('tokenizeBody drops single-character tokens', () => {
  const out = tokenizeBody('a bb ccc');
  assert.ok(!out.includes('a'));
  assert.ok(out.includes('bb'));
  assert.ok(out.includes('ccc'));
});

test('tokenizeBody returns [] for empty / non-string body', () => {
  assert.deepEqual(tokenizeBody(''), []);
  assert.deepEqual(tokenizeBody(null), []);
  assert.deepEqual(tokenizeBody(undefined), []);
});

// ---------- triggerMatchesBody ----------

test('triggerMatchesBody returns matchCount and matchedTokens', () => {
  const body = 'when you handoff to slack ask before clipboard paste';
  const result = triggerMatchesBody('\\b(handoff|clipboard)\\b', body);
  assert.equal(typeof result.matchCount, 'number');
  assert.ok(Array.isArray(result.matchedTokens));
  assert.ok(result.matchCount >= 2);
  assert.ok(result.matchedTokens.includes('handoff'));
  assert.ok(result.matchedTokens.includes('clipboard'));
});

test('triggerMatchesBody returns zero results on malformed regex (try/catch)', () => {
  const result = triggerMatchesBody('([unclosed', 'some body text');
  assert.deepEqual(result, { matchCount: 0, matchedTokens: [] });
});

test('triggerMatchesBody caps body to 8 KB before matching', () => {
  // Build a body where the only match lives well past 8 KB.
  const filler = 'x'.repeat(8 * 1024);
  const tail = ' uniqueToken ';
  const body = filler + tail;
  const result = triggerMatchesBody('\\b(uniqueToken)\\b', body);
  // The match lives past the 8 KB cap, so triggerMatchesBody must not find it.
  assert.equal(result.matchCount, 0);
  assert.deepEqual(result.matchedTokens, []);
});

test('triggerMatchesBody finds matches that live within the first 8 KB', () => {
  const body = 'hello world uniqueToken ' + 'x'.repeat(8 * 1024);
  const result = triggerMatchesBody('\\b(uniqueToken)\\b', body);
  assert.ok(result.matchCount >= 1);
  assert.ok(result.matchedTokens.includes('uniqueToken'));
});

test('triggerMatchesBody returns zero on empty inputs', () => {
  assert.deepEqual(triggerMatchesBody('', 'body'), { matchCount: 0, matchedTokens: [] });
  assert.deepEqual(triggerMatchesBody('\\b(foo)\\b', ''), { matchCount: 0, matchedTokens: [] });
});

// ---------- pretoolArgSets ----------

test('pretoolArgSets groups Tool:argRegex strings by tool name', () => {
  const out = pretoolArgSets([
    'Bash:gh\\s+pr\\s+view',
    'Bash:gh\\s+pr\\s+(view|checkout)',
    'Edit:.*',
  ]);
  assert.ok(out.Bash instanceof Set);
  assert.ok(out.Edit instanceof Set);
  assert.equal(out.Bash.size, 2);
  assert.ok(out.Bash.has('gh\\s+pr\\s+view'));
  assert.ok(out.Bash.has('gh\\s+pr\\s+(view|checkout)'));
  assert.ok(out.Edit.has('.*'));
});

test('pretoolArgSets handles empty / non-array input', () => {
  assert.deepEqual(pretoolArgSets([]), {});
  assert.deepEqual(pretoolArgSets(null), {});
  assert.deepEqual(pretoolArgSets(undefined), {});
});

test('pretoolArgSets skips malformed entries lacking a Tool:arg shape', () => {
  const out = pretoolArgSets(['no-colon-here', 'Bash:ok']);
  assert.ok(out.Bash instanceof Set);
  assert.ok(out.Bash.has('ok'));
  assert.ok(!('no-colon-here' in out));
});

// ---------- jaccard ----------

test('jaccard returns |A ∩ B| / |A ∪ B|', () => {
  const a = new Set(['x', 'y', 'z']);
  const b = new Set(['y', 'z', 'w']);
  // intersection {y,z} size 2, union {x,y,z,w} size 4 => 0.5
  assert.equal(jaccard(a, b), 0.5);
});

test('jaccard returns 0 for two empty sets', () => {
  assert.equal(jaccard(new Set(), new Set()), 0);
});

test('jaccard returns 1 for identical non-empty sets', () => {
  const a = new Set(['x', 'y']);
  const b = new Set(['x', 'y']);
  assert.equal(jaccard(a, b), 1);
});

test('jaccard returns 0 for disjoint sets', () => {
  assert.equal(jaccard(new Set(['x']), new Set(['y'])), 0);
});
