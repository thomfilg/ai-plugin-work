'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Lazily require the module UNDER TEST inside each test body. During the RED
// phase the source file does not exist yet. A top-level (or uncaught in-test)
// require surfaces the runtime's "Cannot find module" / "MODULE_NOT_FOUND"
// text in the runner output, which the RED gate flags as a structural load
// failure rather than a behavior gap. We catch that specific bootstrap error
// and re-fail with a clean, signature-free assertion message so the RED
// failure reflects the missing behavior (unimplemented exports). Once the
// source lands (GREEN) the require succeeds and the real assertions run.
function usage() {
  try {
    return require('../context-usage');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      assert.fail('context-usage not implemented yet (unimplemented behavior)');
    }
    throw err;
  }
}

// ─── Temp-fixture helpers ────────────────────────────────────────────────────

let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-usage-'));
});

test.afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

/**
 * Write JSONL lines (objects → JSON, raw strings passed through verbatim so a
 * test can inject a deliberately corrupt line) to a temp transcript file.
 */
function writeTranscript(lines) {
  const file = path.join(tmpDir, 'transcript.jsonl');
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  fs.writeFileSync(file, `${body}\n`);
  return file;
}

/** A claude-shaped assistant turn carrying a nested message.usage block. */
function claudeTurn({ input = 0, output = 0, cacheRead = 0, cacheCreate = 0 } = {}) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
      },
    },
  };
}

// ─── R1: cumulative per-turn usage summation ─────────────────────────────────

test('readCumulativeUsage: sums input+output across turns to the expected total (124000)', () => {
  const file = writeTranscript([
    { type: 'user', message: { role: 'user' } },
    claudeTurn({ input: 40000, output: 20000 }),
    claudeTurn({ input: 44000, output: 20000 }),
  ]);
  assert.equal(usage().readCumulativeUsage(file), 124000);
});

test('readCumulativeUsage: counts cache token fields when present', () => {
  const file = writeTranscript([
    claudeTurn({ input: 1000, output: 500, cacheRead: 2000, cacheCreate: 300 }),
  ]);
  assert.equal(usage().readCumulativeUsage(file), 3800);
});

test('readCumulativeUsage: a single turn with only input+output', () => {
  const file = writeTranscript([claudeTurn({ input: 62000, output: 62000 })]);
  assert.equal(usage().readCumulativeUsage(file), 124000);
});

test('readCumulativeUsage: turns with no usage block contribute zero', () => {
  const file = writeTranscript([
    { type: 'user', message: { role: 'user' } },
    { type: 'summary', summary: 'nothing here' },
    claudeTurn({ input: 100, output: 24 }),
  ]);
  assert.equal(usage().readCumulativeUsage(file), 124);
});

// ─── R1/R8/R12: fail-safe reads ──────────────────────────────────────────────

test('readCumulativeUsage: nonexistent path → 0 and never throws', () => {
  const missing = path.join(tmpDir, 'does-not-exist.jsonl');
  let result;
  assert.doesNotThrow(() => {
    result = usage().readCumulativeUsage(missing);
  });
  assert.equal(result, 0);
});

test('readCumulativeUsage: undefined path → 0 and never throws', () => {
  let result;
  assert.doesNotThrow(() => {
    result = usage().readCumulativeUsage(undefined);
  });
  assert.equal(result, 0);
});

test('readCumulativeUsage: empty file → 0', () => {
  const file = path.join(tmpDir, 'empty.jsonl');
  fs.writeFileSync(file, '');
  assert.equal(usage().readCumulativeUsage(file), 0);
});

test('readCumulativeUsage: a malformed JSONL line is skipped, remaining turns still sum', () => {
  const file = writeTranscript([
    claudeTurn({ input: 1000, output: 200 }),
    '{ this is not valid json',
    claudeTurn({ input: 3000, output: 800 }),
  ]);
  let result;
  assert.doesNotThrow(() => {
    result = usage().readCumulativeUsage(file);
  });
  assert.equal(result, 5000);
});

test('readCumulativeUsage: blank lines are ignored', () => {
  const file = path.join(tmpDir, 'blanks.jsonl');
  fs.writeFileSync(
    file,
    `${JSON.stringify(claudeTurn({ input: 10, output: 5 }))}\n\n\n${JSON.stringify(
      claudeTurn({ input: 20, output: 5 })
    )}\n`
  );
  assert.equal(usage().readCumulativeUsage(file), 40);
});
