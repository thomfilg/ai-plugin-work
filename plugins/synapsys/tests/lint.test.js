'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'clean-manifest.json');
const LINT_PATH = path.join(__dirname, '..', 'scripts', 'synapsys-crystallize-lint.js');

function makeMemory(overrides) {
  return Object.assign(
    {
      name: 'test-memory',
      description: 'test',
      events: ['UserPromptSubmit'],
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

function assertExitCode(result, expected, msg) {
  assert.equal(result.status, expected, msg || `expected exit ${expected}, got ${result.status}`);
}

test('Clean manifest passes through unchanged', () => {
  // G1: child-process round-trip — clean fixture → exit 0, empty warnings/errors, manifest unchanged.
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const original = JSON.parse(raw);
  const result = runLint(raw);
  assertExitCode(result, 0, 'child process exits 0 on clean fixture');
  assert.deepEqual(result.env.warnings, [], 'no warnings');
  assert.deepEqual(result.env.errors, [], 'no errors');
  assert.deepEqual(result.env.manifest, original, 'manifest passes through unchanged');
});

test('Stop-word trigger tokens raise R2 errors and exit non-zero', () => {
  // G2: \b(permission|hook|blocked)\b → exactly 3 R2-stopword errors, exit 1.
  const { STOP_WORDS } = require(LINT_PATH);
  assert.ok(
    STOP_WORDS.has('permission') && STOP_WORDS.has('hook') && STOP_WORDS.has('blocked'),
    'STOP_WORDS includes permission/hook/blocked'
  );

  const manifest = {
    memories: [
      makeMemory({ name: 'stopword-mem', trigger_prompt: '\\b(permission|hook|blocked)\\b' }),
    ],
  };
  const result = runLint(manifest);
  assertExitCode(result, 1, 'child process exits 1 when R2 errors present');
  const r2 = result.env.errors.filter((e) => e.rule === 'R2-stopword');
  assert.equal(r2.length, 3, 'exactly three R2-stopword errors emitted (one per token)');
  const tokens = r2
    .map((e) => e.message)
    .join(' ')
    .toLowerCase();
  for (const t of ['permission', 'hook', 'blocked']) {
    assert.ok(tokens.includes(t), `R2 message references token "${t}"`);
  }
});

test('R2 ignores multi-word phrases', () => {
  // G3: \b(git\s+push|amend)\b → no R2 errors (git\s+push is multi-word, amend not in STOP_WORDS).
  const manifest = {
    memories: [makeMemory({ name: 'phrase-mem', trigger_prompt: '\\b(git\\s+push|amend)\\b' })],
  };
  const result = runLint(manifest);
  const r2 = result.env.errors.filter((e) => e.rule === 'R2-stopword');
  assert.equal(r2.length, 0, 'R2 emits no errors for multi-word phrase alternation');
  for (const e of r2) {
    assert.ok(!/\bpush\b/i.test(e.message), 'no R2 error should flag "push" inside "git\\s+push"');
  }
});

test('R7 auto-fixes inject=full when body exceeds 30 lines', () => {
  // G4: inject=full + 50-line body → manifest.inject mutated to 'summary', R7 warning, exit 0.
  const { RULES } = require(LINT_PATH);
  assert.equal(RULES.length, 10, 'RULES registry has 10 rules');
  const longBody = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  const manifest = {
    memories: [makeMemory({ name: 'long-full-mem', inject: 'full', body: longBody })],
  };
  const result = runLint(manifest);
  assertExitCode(result, 0, 'child process exits 0 when only warnings present');
  const r7 = result.env.warnings.filter((w) => w.rule === 'R7-inject-full-too-long');
  assert.equal(r7.length, 1, 'exactly one R7-inject-full-too-long warning emitted');
  assert.ok(/long-full-mem/.test(r7[0].message || ''), 'R7 warning names the memory');
  assert.equal(
    result.env.manifest.memories[0].inject,
    'summary',
    'stdout manifest reflects auto-fix to "summary"'
  );
  assert.equal(result.env.errors.length, 0, 'no errors emitted by R7 auto-fix path');
});

test('R4 errors when PreToolUse is configured without trigger_pretool', () => {
  // G5: events includes PreToolUse but trigger_pretool empty/missing → R4 error, exit 1.
  const manifestEmpty = {
    memories: [makeMemory({ events: ['UserPromptSubmit', 'PreToolUse'], trigger_pretool: [] })],
  };
  const resultEmpty = runLint(manifestEmpty);
  assertExitCode(resultEmpty, 1, 'exit 1 when trigger_pretool is empty');
  assert.ok(
    resultEmpty.env.errors.some((e) => e.rule === 'R4-empty-pretool'),
    'R4-empty-pretool error fires when trigger_pretool is empty'
  );

  const memMissing = makeMemory({ events: ['UserPromptSubmit', 'PreToolUse'] });
  delete memMissing.trigger_pretool;
  const resultMissing = runLint({ memories: [memMissing] });
  assertExitCode(resultMissing, 1, 'exit 1 when trigger_pretool is missing');
  assert.ok(
    resultMissing.env.errors.some((e) => e.rule === 'R4-empty-pretool'),
    'R4-empty-pretool error fires when trigger_pretool is missing'
  );
});

test('R7-inject-full leaves short-body manifests unchanged', () => {
  // R7 case: inject=full with body ≤ 30 lines must NOT auto-fix and must NOT warn.
  const shortBody = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
  const manifest = {
    memories: [makeMemory({ name: 'short-full-mem', inject: 'full', body: shortBody })],
  };
  const result = runLint(manifest);
  assertExitCode(result, 0, 'exit 0 when no errors');
  const r7 = result.env.warnings.filter((w) => w.rule === 'R7-inject-full-too-long');
  assert.equal(r7.length, 0, 'no R7 warning when body ≤ 30 lines');
  assert.equal(result.env.manifest.memories[0].inject, 'full', 'inject left unchanged');
});

test('R8 fires when memory has Stop event but body lacks retro guidance', () => {
  // GH-440 bot review: R8 must check the events array, not the body keyword,
  // so a "Stop" classifier assignment without retrospective body text warns.
  const manifest = {
    memories: [
      makeMemory({
        name: 'stop-no-retro',
        events: ['PreToolUse', 'Stop'],
        body: 'Check the deploy succeeded.',
      }),
    ],
  };
  const result = runLint(manifest);
  const r8 = result.env.warnings.filter((w) => w.rule === 'R8-stop-without-retro');
  assert.equal(r8.length, 1, 'one R8 warning when Stop event present without retro guidance');
});

test('R8 stays quiet when Stop-event memory body has retrospective guidance', () => {
  const manifest = {
    memories: [
      makeMemory({
        name: 'stop-with-retro',
        events: ['PreToolUse', 'Stop'],
        body: 'After git push: did I run follow-up-pr?',
      }),
    ],
  };
  const result = runLint(manifest);
  const r8 = result.env.warnings.filter((w) => w.rule === 'R8-stop-without-retro');
  assert.equal(r8.length, 0, 'no R8 warning when body has retrospective keywords');
});

test('R8 ignores body "STOP" without a Stop event (no false positive)', () => {
  // Pre-fix the rule fired on any \bSTOP\b in body even for non-Stop memories
  // (e.g. "STOP pushing to main"). With the events-array check the rule no
  // longer flags those.
  const manifest = {
    memories: [
      makeMemory({
        name: 'body-stop-no-event',
        events: ['UserPromptSubmit'],
        body: 'STOP pushing to main without review.',
      }),
    ],
  };
  const result = runLint(manifest);
  const r8 = result.env.warnings.filter((w) => w.rule === 'R8-stop-without-retro');
  assert.equal(r8.length, 0, 'no R8 false positive when body has STOP but no Stop event');
});
