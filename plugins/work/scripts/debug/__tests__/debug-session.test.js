'use strict';

/**
 * Tests for debug-session.js — the deterministic CommonJS helper behind
 * the /debug skill: init / status / list, with a path-traversal guard,
 * quote/newline escaping into YAML frontmatter, and fail-safe non-zero
 * exits for missing-file and malformed-frontmatter.
 *
 * The CLI is exercised as a child process (the established pattern in this
 * repo) so exit codes and stdout are asserted against real process output.
 * Temp dirs are created with fs.mkdtempSync and torn down in afterEach.
 *
 * node:test + node:assert/strict; zero runtime deps.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'debug-session.js');
const SESSION_FILE = '.debug-session.md';

/** Run `node debug-session.js <args...>` inside `cwd`. */
function runCli(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh316-debug-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('debug-session.js CLI', () => {
  it('Starting a session seeds the state file', () => {
    const res = runCli(['init', 'TypeError in useCollectionDetail hook'], tmpDir);
    assert.equal(res.status, 0, `init should exit 0, got ${res.status}: ${res.stderr}`);

    const filePath = path.join(tmpDir, SESSION_FILE);
    assert.ok(fs.existsSync(filePath), '.debug-session.md should be created at cwd');

    const content = fs.readFileSync(filePath, 'utf8');

    // Frontmatter is delimited by --- fences.
    assert.match(content, /^---\n/, 'file should open with a YAML frontmatter fence');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fmMatch, 'frontmatter block should be present');
    const frontmatter = fmMatch[1];

    // status defaults to active.
    assert.match(frontmatter, /status:\s*active/, 'status should default to active');
    // trigger text is recorded.
    assert.match(
      frontmatter,
      /TypeError in useCollectionDetail hook/,
      'trigger text should be recorded in frontmatter'
    );

    // created / updated are ISO dates (YYYY-MM-DD) and equal on init.
    const created = frontmatter.match(/created:\s*"?(\d{4}-\d{2}-\d{2})"?/);
    const updated = frontmatter.match(/updated:\s*"?(\d{4}-\d{2}-\d{2})"?/);
    assert.ok(created, 'created should be an ISO date (YYYY-MM-DD)');
    assert.ok(updated, 'updated should be an ISO date (YYYY-MM-DD)');
    assert.equal(created[1], updated[1], 'created and updated should be equal on init');

    // The three required sections appear, empty, in order.
    const hIdx = content.indexOf('## Hypotheses');
    const eIdx = content.indexOf('## Evidence');
    const fIdx = content.indexOf('## Current Focus');
    assert.ok(hIdx !== -1, '## Hypotheses section should be present');
    assert.ok(eIdx !== -1, '## Evidence section should be present');
    assert.ok(fIdx !== -1, '## Current Focus section should be present');
    assert.ok(
      hIdx < eIdx && eIdx < fIdx,
      'sections should appear in order: Hypotheses, Evidence, Current Focus'
    );
  });

  it('status prints current state without launching an investigation', () => {
    const filePath = path.join(tmpDir, SESSION_FILE);
    fs.writeFileSync(
      filePath,
      [
        '---',
        'status: active',
        'trigger: "TypeError in useCollectionDetail hook"',
        'created: "2026-07-12"',
        'updated: "2026-07-12"',
        '---',
        '',
        '## Hypotheses',
        '',
        '1. [TESTING] The hook derefs an undefined response before the fetch resolves',
        '',
        '## Evidence',
        '',
        '- Stack trace points at useCollectionDetail.ts:42',
        '',
        '## Current Focus',
        '',
        '- Active hypothesis: The hook derefs an undefined response before the fetch resolves',
        '- Next action: Add a loading guard and re-run the failing test',
        '- Files to check: useCollectionDetail.ts',
        '',
      ].join('\n')
    );

    const before = fs.readFileSync(filePath);
    const res = runCli(['status'], tmpDir);
    const after = fs.readFileSync(filePath);

    assert.equal(res.status, 0, `status should exit 0, got ${res.status}: ${res.stderr}`);

    const out = res.stdout;
    // Prints status, active hypothesis, and next action.
    assert.match(out, /active/, 'status output should include the status');
    assert.match(
      out,
      /derefs an undefined response before the fetch resolves/,
      'status output should include the active hypothesis'
    );
    assert.match(
      out,
      /Add a loading guard and re-run the failing test/,
      'status output should include the next action'
    );

    // status must not mutate the file.
    assert.ok(before.equals(after), 'status must not modify the session file');
  });

  it('status fails clearly when no session exists', () => {
    const res = runCli(['status'], tmpDir);

    assert.notEqual(res.status, 0, 'status with no session file should exit non-zero');
    const combined = `${res.stdout}${res.stderr}`;
    assert.match(
      combined,
      /no.*session|session.*not found|\.debug-session\.md/i,
      'status should print a clear no-session message'
    );
  });

  it('list reports each session with its status and trigger', () => {
    fs.writeFileSync(
      path.join(tmpDir, SESSION_FILE),
      [
        '---',
        'status: active',
        'trigger: "Flaky checkout timeout under load"',
        'created: "2026-07-12"',
        'updated: "2026-07-12"',
        '---',
        '',
        '## Hypotheses',
        '',
        '## Evidence',
        '',
        '## Current Focus',
        '',
      ].join('\n')
    );

    const res = runCli(['list'], tmpDir);
    assert.equal(res.status, 0, `list should exit 0, got ${res.status}: ${res.stderr}`);

    const out = res.stdout;
    // One line per session: status + trigger, with active marked distinctly
    // from the completed statuses (resolved/diagnosed/abandoned).
    assert.match(out, /active/, 'list output should show the status');
    assert.match(out, /Flaky checkout timeout under load/, 'list output should show the trigger');
  });

  it('malformed frontmatter is handled safely', () => {
    // A file with a broken/incomplete frontmatter block (no closing fence).
    fs.writeFileSync(
      path.join(tmpDir, SESSION_FILE),
      ['---', 'status: active', 'trigger: "unterminated', '## Hypotheses', ''].join('\n')
    );

    const res = runCli(['status'], tmpDir);

    assert.notEqual(res.status, 0, 'malformed frontmatter should exit non-zero');
    // No unhandled throw / stack trace leaked to stderr.
    assert.doesNotMatch(
      res.stderr || '',
      /at Object\.<anonymous>|Error:\s*Unexpected|node:internal/,
      'malformed frontmatter must fail safe, not throw an unhandled error'
    );
    const combined = `${res.stdout}${res.stderr}`;
    assert.match(
      combined,
      /malformed|could not parse|invalid frontmatter|parse/i,
      'malformed frontmatter should print a fail-safe parse message'
    );
  });

  it('init rejects a path-traversal argument', () => {
    // A path-traversal / absolute path passed where a safe cwd-relative
    // target is expected must be refused, writing nothing outside cwd.
    const traversal = path.join('..', 'escape.md');
    const res = runCli(['init', 'legit description', traversal], tmpDir);

    assert.notEqual(res.status, 0, 'a path-traversal argument should be rejected (non-zero exit)');
    const combined = `${res.stdout}${res.stderr}`;
    assert.match(
      combined,
      /invalid|traversal|not allowed|refused|\.\./i,
      'path-traversal rejection should report a validation error'
    );

    // Nothing written outside cwd.
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '..', 'escape.md')),
      'no file should be written outside cwd'
    );
  });
});
