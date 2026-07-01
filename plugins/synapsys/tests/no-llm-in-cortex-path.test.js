'use strict';

// Non-goal lint test (R11, R16): the auto-recall cortex path must perform ZERO
// model calls. This statically asserts that none of the cortex library modules
// require a known model-client SDK.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIB_DIR = path.join(__dirname, '..', 'lib');

// Forbidden model-client require substrings. If any appears in a cortex lib,
// the auto-recall path could issue a model call — a hard non-goal.
const FORBIDDEN_PATTERNS = [
  '@anthropic',
  'openai',
  '@google/generative-ai',
  'cohere',
  'mistralai',
];

function cortexLibFiles() {
  return fs
    .readdirSync(LIB_DIR)
    .filter((name) => /^cortex-.*\.js$/.test(name))
    .map((name) => path.join(LIB_DIR, name));
}

test('cortex lib files exist to lint', () => {
  const files = cortexLibFiles();
  assert.ok(files.length > 0, 'expected at least one lib/cortex-*.js file');
});

test('no model-client require appears in any lib/cortex-*.js', () => {
  for (const file of cortexLibFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert.ok(
        !source.includes(pattern),
        `forbidden model-client reference "${pattern}" found in ${path.basename(file)}`
      );
    }
  }
});
