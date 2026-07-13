'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LINT_PATH = path.join(__dirname, '..', 'scripts', 'synapsys-crystallize-lint.js');

function makeMemory(overrides) {
  return Object.assign(
    {
      name: 'test-memory',
      description: 'test',
      events: ['UserPromptSubmit', 'PreToolUse'],
      trigger_prompt: '\\b(release|version|publish)\\b',
      trigger_pretool: ['Bash:gh release'],
      trigger_session: false,
      inject: 'summary',
      body: 'Some safe body content.',
    },
    overrides
  );
}

function runLint(manifest) {
  const input = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
  const r = spawnSync(process.execPath, [LINT_PATH], { input, encoding: 'utf8' });
  let env = null;
  try {
    env = JSON.parse(r.stdout);
  } catch (_) {
    /* tolerate non-JSON for negative cases */
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, env };
}

// S11 — P0 #9 — lint rule R10 warns on negative without positive
test('P0 #9 — lint rule R10 warns on negative without positive', () => {
  // R10-neg-without-pos: trigger_pretool_content_not present AND trigger_pretool_content absent/empty → warn.
  const memNegOnly = makeMemory({
    name: 'neg-only-mem',
    trigger_pretool_content_not: ['@app-services-monitoring/ui'],
  });
  delete memNegOnly.trigger_pretool_content;
  const resultMissing = runLint({ memories: [memNegOnly] });
  const r10Missing = resultMissing.env.warnings.filter((w) => w.rule === 'R10-neg-without-pos');
  assert.equal(
    r10Missing.length,
    1,
    'exactly one R10-neg-without-pos warning when positive field absent'
  );
  assert.ok(
    /neg-only-mem/.test(r10Missing[0].message || ''),
    'R10 warning references the memory name'
  );

  // Empty positive array also triggers R10.
  const memEmpty = makeMemory({
    name: 'neg-only-empty-pos',
    trigger_pretool_content: [],
    trigger_pretool_content_not: ['@app-services-monitoring/ui'],
  });
  const resultEmpty = runLint({ memories: [memEmpty] });
  const r10Empty = resultEmpty.env.warnings.filter((w) => w.rule === 'R10-neg-without-pos');
  assert.equal(
    r10Empty.length,
    1,
    'exactly one R10-neg-without-pos warning when positive field empty'
  );

  // When positive field is present and non-empty, R10 does NOT warn.
  const memBoth = makeMemory({
    name: 'both-fields-mem',
    trigger_pretool_content: ['Button'],
    trigger_pretool_content_not: ['@app-services-monitoring/ui'],
  });
  const resultBoth = runLint({ memories: [memBoth] });
  const r10Both = resultBoth.env.warnings.filter((w) => w.rule === 'R10-neg-without-pos');
  assert.equal(r10Both.length, 0, 'no R10 warning when positive field is present and non-empty');

  // Registry shape: R10 registered with severity 'warn', scope 'memory'.
  const { RULES } = require(LINT_PATH);
  const r10 = RULES.find((r) => r.id === 'R10-neg-without-pos');
  assert.ok(r10, 'R10-neg-without-pos registered in RULES array');
  assert.equal(r10.severity, 'warn', 'R10 severity is "warn"');
  assert.equal(r10.scope, 'memory', 'R10 scope is "memory"');
});
