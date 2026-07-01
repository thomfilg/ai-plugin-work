'use strict';

// Non-goal lint test (R11, R17): the auto-recall code path must never write
// memories. This statically asserts that the literal `cortex_remember` does not
// appear in any auto-recall source file under lib/ or scripts/. Writes remain
// agent-driven, never triggered automatically by recall.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FORBIDDEN_TOKEN = 'cortex_remember';

// Auto-recall code paths: the cortex libs, the session cache used by recall,
// and the background recall script.
const AUTO_RECALL_FILES = [
  ['lib', 'cortex-config.js'],
  ['lib', 'cortex-format.js'],
  ['lib', 'cortex-recall.js'],
  ['lib', 'session-cache.js'],
  ['scripts', 'synapsys-cortex-recall-bg.js'],
].map((parts) => path.join(__dirname, '..', ...parts));

test('auto-recall source files exist to lint', () => {
  for (const file of AUTO_RECALL_FILES) {
    assert.ok(fs.existsSync(file), `expected auto-recall file to exist: ${file}`);
  }
});

test('no cortex_remember reference appears in any auto-recall code path', () => {
  for (const file of AUTO_RECALL_FILES) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(
      !source.includes(FORBIDDEN_TOKEN),
      `forbidden token "${FORBIDDEN_TOKEN}" found in ${path.relative(path.join(__dirname, '..'), file)}`
    );
  }
});
