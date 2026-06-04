'use strict';

/**
 * Task 2 — Swap crystallize lint to import shared `extractAlternationTokens`.
 *
 * Scenario covered (verbatim from gherkin.feature):
 *   Crystallize lint sources `extractAlternationTokens` from the shared library after swap
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'synapsys-crystallize-lint.js'
);

test('Crystallize lint sources `extractAlternationTokens` from the shared library after swap', () => {
  // Loading the script must not throw.
  assert.doesNotThrow(() => {
    require(SCRIPT_PATH);
  });

  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');

  // After the swap, the local function definition must be gone.
  assert.ok(
    !/function\s+extractAlternationTokens\s*\(/.test(source),
    'expected local `function extractAlternationTokens(...)` definition to be removed from synapsys-crystallize-lint.js'
  );

  // ...and the script must require the shared library.
  assert.ok(
    /require\(\s*['"]\.\.\/lib\/shared\/trigger-tokens['"]\s*\)/.test(source),
    "expected synapsys-crystallize-lint.js to `require('../lib/shared/trigger-tokens')`"
  );
});
