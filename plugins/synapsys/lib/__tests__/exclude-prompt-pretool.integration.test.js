'use strict';

/**
 * Integration tests for GH-510 Task 2 — exclude_prompt / exclude_pretool /
 * exclude_preset gating in matcher.js.
 *
 * Six scenarios mirror Feature: synapsys exclude gating in gherkin.feature:
 *   1. positive trigger fires when no exclude matches
 *   2. exclude_prompt suppresses a positive trigger match
 *   3. exclude_pretool suppresses a positive pretool match
 *   4. exclude_preset resolves named bundle from synapsys-presets.json
 *   5. invalid exclude regex is skipped without aborting the matcher
 *   6. backwards-compat: memories without exclude_* fields behave identically
 *
 * Plus direct-helper assertions on evaluateExcludePrompt /
 * evaluateExcludePretool / hasExcludePatterns.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const matcherModule = require('../matcher');
const {
  matchPrompt,
  matchPreTool,
  matchPreToolResult,
  evaluateExcludePrompt,
  evaluateExcludePretool,
  hasExcludePatterns,
} = matcherModule;
const { listMemoriesFromStore, resolvePreset } = require('../memory-store');

function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const ret = fn();
    return { ret, stderr: chunks.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

function makeStoreDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `synapsys-exclude-${label}-`));
  const storeDir = path.join(dir, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: `exclude-${label}-fixture` })
  );
  return {
    cwd: dir,
    store: { kind: 'local', dir: storeDir, projectName: `exclude-${label}-fixture` },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function writeMemory(store, basename, frontmatterLines, body = 'Body line.') {
  const file = path.join(store.dir, `${basename}.md`);
  const content = ['---', ...frontmatterLines, '---', '', body, ''].join('\n');
  fs.writeFileSync(file, content);
  return file;
}

// ---------------------------------------------------------------------------
// Direct helper assertions
// ---------------------------------------------------------------------------

test('evaluateExcludePrompt returns {excluded:true, pattern} when a resolved pattern matches', () => {
  const mem = { name: 'mem-x', excludeResolved: ['\\bgit\\s+merge\\b'] };
  const r = evaluateExcludePrompt(mem, 'git merge feature');
  assert.deepEqual(r, { excluded: true, pattern: '\\bgit\\s+merge\\b' });
});

test('evaluateExcludePrompt returns {excluded:false, pattern:null} when no pattern matches', () => {
  const mem = { name: 'mem-x', excludeResolved: ['\\bgit\\s+merge\\b'] };
  const r = evaluateExcludePrompt(mem, 'review the PR');
  assert.deepEqual(r, { excluded: false, pattern: null });
});

test('evaluateExcludePrompt returns {excluded:false, pattern:null} on empty/missing excludeResolved', () => {
  assert.deepEqual(evaluateExcludePrompt({ name: 'a' }, 'anything'), {
    excluded: false,
    pattern: null,
  });
  assert.deepEqual(evaluateExcludePrompt({ name: 'b', excludeResolved: [] }, 'anything'), {
    excluded: false,
    pattern: null,
  });
});

test('evaluateExcludePrompt: invalid regex is skipped with stderr warning; remaining patterns still gate', () => {
  const mem = { name: 'mem-mixed', excludeResolved: ['(unclosed', '\\bgit\\s+merge\\b'] };
  const { ret, stderr } = captureStderr(() => evaluateExcludePrompt(mem, 'git merge x'));
  assert.deepEqual(ret, { excluded: true, pattern: '\\bgit\\s+merge\\b' });
  assert.match(stderr, /\[synapsys\]/);
  assert.match(stderr, /invalid exclude/i);
  assert.match(stderr, /\(unclosed/);
});

test('evaluateExcludePretool returns {excluded:true, pattern} when a spec matches tool+argblob', () => {
  const mem = {
    name: 'mem-pt',
    excludePretool: ['Bash:git\\s+(merge|push|rebase)'],
  };
  const r = evaluateExcludePretool(mem, 'Bash', JSON.stringify({ command: 'git merge main' }));
  assert.deepEqual(r, { excluded: true, pattern: 'Bash:git\\s+(merge|push|rebase)' });
});

test('evaluateExcludePretool returns {excluded:false, pattern:null} when tool name does not match spec', () => {
  const mem = { name: 'mem-pt', excludePretool: ['Bash:git\\s+merge'] };
  const r = evaluateExcludePretool(mem, 'Edit', JSON.stringify({ new_string: 'git merge' }));
  assert.deepEqual(r, { excluded: false, pattern: null });
});

test('evaluateExcludePretool returns {excluded:false, pattern:null} on empty/missing excludePretool', () => {
  assert.deepEqual(evaluateExcludePretool({ name: 'a' }, 'Bash', '{}'), {
    excluded: false,
    pattern: null,
  });
});

test('hasExcludePatterns returns true iff excludeResolved or excludePretool is non-empty', () => {
  assert.equal(hasExcludePatterns({ name: 'a' }), false);
  assert.equal(hasExcludePatterns({ name: 'b', excludeResolved: [], excludePretool: [] }), false);
  assert.equal(hasExcludePatterns({ name: 'c', excludeResolved: ['x'] }), true);
  assert.equal(hasExcludePatterns({ name: 'd', excludePretool: ['Bash:x'] }), true);
});

// ---------------------------------------------------------------------------
// Scenario 1: positive trigger fires when no exclude matches
// ---------------------------------------------------------------------------

test('Scenario 1: positive trigger fires when no exclude matches', (t) => {
  const fx = makeStoreDir('s1');
  t.after(fx.cleanup);
  writeMemory(fx.store, 'mem', [
    'name: mem',
    'events: UserPromptSubmit',
    'trigger_prompt: \\blinear\\b',
    'exclude_prompt: \\bgit\\s+merge\\b',
  ]);
  const [mem] = listMemoriesFromStore(fx.store);
  const result = matchPrompt(mem, 'fetch the linear ticket');
  assert.equal(result.fired, true);
  assert.equal(result.reason, undefined);
});

// ---------------------------------------------------------------------------
// Scenario 2: exclude_prompt suppresses a positive trigger match
// ---------------------------------------------------------------------------

test('Scenario 2: exclude_prompt suppresses a positive trigger match', (t) => {
  const fx = makeStoreDir('s2');
  t.after(fx.cleanup);
  writeMemory(fx.store, 'mem', [
    'name: mem',
    'events: UserPromptSubmit',
    'trigger_prompt: \\blinear\\b',
    'exclude_prompt: \\bgit\\s+merge\\b',
  ]);
  const [mem] = listMemoriesFromStore(fx.store);
  const result = matchPrompt(mem, 'git merge linear branch into main');
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'exclude-matched');
  assert.ok(result.matched);
  assert.match(result.matched.excluded_pattern, /git\\s\+merge/);
});

// ---------------------------------------------------------------------------
// Scenario 3: exclude_pretool suppresses a positive pretool match
// ---------------------------------------------------------------------------

test('Scenario 3: exclude_pretool suppresses a positive pretool match', (t) => {
  const fx = makeStoreDir('s3');
  t.after(fx.cleanup);
  writeMemory(fx.store, 'mem', [
    'name: mem',
    'events: PreToolUse',
    'trigger_pretool: Bash:git',
    'exclude_pretool: Bash:git\\s+(merge|push|rebase)',
  ]);
  const [mem] = listMemoriesFromStore(fx.store);
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'git merge feature' },
  };
  const result = matchPreTool(mem, payload);
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'exclude-matched');
  assert.ok(result.matched);
  assert.match(result.matched.excluded_pattern, /merge|push|rebase/);

  // matchPreToolResult mirrors the same shape
  const rResult = matchPreToolResult(mem, payload);
  assert.equal(rResult.reason, 'exclude-matched');
  assert.ok(rResult.matched.excluded_pattern);
});

// ---------------------------------------------------------------------------
// Scenario 4: exclude_preset resolves named bundle from synapsys-presets.json
// ---------------------------------------------------------------------------

test('Scenario 4: exclude_preset resolves named bundle and suppresses match', (t) => {
  const fx = makeStoreDir('s4');
  t.after(fx.cleanup);
  writeMemory(fx.store, 'mem', [
    'name: mem',
    'events: UserPromptSubmit',
    'trigger_prompt: \\bticket\\b',
    'exclude_preset: git-ops',
  ]);
  const [mem] = listMemoriesFromStore(fx.store);
  assert.deepEqual(mem.excludePreset, ['git-ops']);
  assert.ok(mem.excludeResolved.length > 0, 'preset should be resolved into excludeResolved');

  const result = matchPrompt(mem, 'git rebase the ticket branch');
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'exclude-matched');
  const gitOpsBody = resolvePreset('git-ops');
  assert.equal(
    result.matched.excluded_pattern,
    gitOpsBody,
    'excluded_pattern should be the git-ops preset body'
  );
});

// ---------------------------------------------------------------------------
// Scenario 5: invalid exclude regex is skipped without aborting the matcher
// ---------------------------------------------------------------------------

test('Scenario 5: invalid exclude regex is skipped with stderr warning; remaining presets still gate', (t) => {
  const fx = makeStoreDir('s5');
  t.after(fx.cleanup);
  writeMemory(fx.store, 'mem', [
    'name: mem',
    'events: UserPromptSubmit',
    'trigger_prompt: \\bdeploy\\b',
    "exclude_prompt: '(unclosed'",
    'exclude_preset: ci-monitor',
  ]);
  const [mem] = listMemoriesFromStore(fx.store);
  const { ret, stderr } = captureStderr(() =>
    matchPrompt(mem, 'gh run watch the deploy workflow')
  );
  assert.equal(ret.fired, false);
  assert.equal(ret.reason, 'exclude-matched');
  assert.match(stderr, /\[synapsys\]/);
  assert.match(stderr, /invalid exclude/i);
});

// ---------------------------------------------------------------------------
// Scenario 6: backwards compatibility — no exclude_* fields behave identically
// ---------------------------------------------------------------------------

test('Scenario 6: memories without any exclude_* field behave identically (backwards-compat)', (t) => {
  const fx = makeStoreDir('s6');
  t.after(fx.cleanup);
  writeMemory(fx.store, 'mem', [
    'name: mem',
    'events: UserPromptSubmit',
    'trigger_prompt: \\bticket\\b',
  ]);
  const [mem] = listMemoriesFromStore(fx.store);
  assert.deepEqual(mem.excludeResolved, []);
  assert.deepEqual(mem.excludePretool, []);

  const result = matchPrompt(mem, 'open the ticket linked in the PR');
  assert.equal(result.fired, true);
  assert.equal(result.reason, undefined);
  // Matched contract identical to today: prompt_token + prompt_substring only.
  assert.ok(result.matched);
  assert.ok(result.matched.prompt_token);
  assert.ok(result.matched.prompt_substring);
  assert.equal(result.matched.excluded_pattern, undefined);
});

// ---------------------------------------------------------------------------
// Bonus: exclude composes with GH-445 content-not without conflict
// ---------------------------------------------------------------------------

test('Bonus: exclude composes with content-not; negative-excludes retains priority', (t) => {
  const fx = makeStoreDir('compose');
  t.after(fx.cleanup);
  writeMemory(fx.store, 'mem', [
    'name: mem',
    'events: PreToolUse',
    'trigger_pretool: Edit:.*',
    'trigger_pretool_content: import React',
    'trigger_pretool_content_not: alreadyImported',
    'exclude_pretool: Bash:git\\s+merge',
  ]);
  const [mem] = listMemoriesFromStore(fx.store);
  // Edit payload with alreadyImported in content -> negative-excludes path
  const payload = {
    tool_name: 'Edit',
    tool_input: { new_string: 'import React; // alreadyImported' },
  };
  const result = matchPreTool(mem, payload);
  assert.equal(result.fired, false);
  assert.equal(
    result.reason,
    'negative-excludes',
    'negative-excludes from content-not must take priority over exclude-matched'
  );
});
