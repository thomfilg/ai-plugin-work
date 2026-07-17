'use strict';

/**
 * debugger-doc — documentation assertion tests for the `debugger` agent.
 *
 * Reads plugins/work/agents/debugger.md and pins its required content per
 * Task 2 (GH-316) Acceptance Criteria:
 *   - Frontmatter: name: debugger (+ description/tools/model/color), mirroring
 *     reports-writer.md / cleanup-runner.md.
 *   - A NEVER CALL YOURSELF self-recursion guard.
 *   - Session markers [TESTED - REJECTED] / [TESTING] / [UNTESTED] and the
 *     ## Hypotheses / ## Evidence / ## Current Focus sections.
 *   - The scientific-method loop (hypothesize -> test -> record evidence ->
 *     update hypothesis status -> re-focus).
 *   - The three modes: investigate / diagnose / continue.
 *   - continue: read the file first, resume from ## Current Focus, NEVER re-test
 *     a TESTED hypothesis, and on low context checkpoint (## Current Focus +
 *     updated date) and exit cleanly.
 *   - diagnose: root-cause only, applies NO fix, status: diagnosed.
 *   - Non-diagnose completion: status: resolved with root cause + fix.
 *   - The agent reads/writes only .debug-session.md and the code under test.
 *
 * Requirements covered: R2, R3, R4, R7, R8, R9, R12.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DEBUGGER_MD_PATH = path.join(__dirname, '..', '..', '..', 'agents', 'debugger.md');

function readDebuggerMd() {
  return fs.readFileSync(DEBUGGER_MD_PATH, 'utf8');
}

/** Extract the leading YAML frontmatter block (between the first pair of --- fences). */
function readFrontmatter() {
  const content = readDebuggerMd();
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, 'expected a leading YAML frontmatter block fenced by ---');
  return match[1];
}

test('debugger.md carries frontmatter with name: debugger', () => {
  const fm = readFrontmatter();
  assert.match(fm, /^name:\s*debugger\s*$/m, 'expected "name: debugger" in the frontmatter');
});

test('debugger.md frontmatter includes description, tools, model, and color', () => {
  const fm = readFrontmatter();
  assert.match(fm, /^description:/m, 'expected a "description:" key in the frontmatter');
  assert.match(fm, /^tools:/m, 'expected a "tools:" key in the frontmatter');
  assert.match(fm, /^model:/m, 'expected a "model:" key in the frontmatter');
  assert.match(fm, /^color:/m, 'expected a "color:" key in the frontmatter');
});

test('debugger.md has a NEVER CALL YOURSELF self-recursion guard', () => {
  const content = readDebuggerMd();
  assert.match(content, /NEVER CALL YOURSELF/, 'expected a "NEVER CALL YOURSELF" guard block');
  assert.match(
    content,
    /NEVER use the Task tool to invoke\s+debugger/i,
    'expected the guard to forbid invoking debugger via the Task tool'
  );
});

test('debugger.md defines the three session markers', () => {
  const content = readDebuggerMd();
  assert.match(content, /\[TESTED - REJECTED\]/, 'expected the [TESTED - REJECTED] marker');
  assert.match(content, /\[TESTING\]/, 'expected the [TESTING] marker');
  assert.match(content, /\[UNTESTED\]/, 'expected the [UNTESTED] marker');
});

test('debugger.md defines the ## Hypotheses / ## Evidence / ## Current Focus sections', () => {
  const content = readDebuggerMd();
  assert.match(content, /##\s+Hypotheses\b/, 'expected a "## Hypotheses" section');
  assert.match(content, /##\s+Evidence\b/, 'expected an "## Evidence" section');
  assert.match(content, /##\s+Current Focus\b/, 'expected a "## Current Focus" section');
});

test('debugger.md describes the scientific-method loop', () => {
  const content = readDebuggerMd();
  assert.match(content, /scientific[- ]method/i, 'expected the scientific-method loop to be named');
  assert.match(content, /hypothesi[sz]e/i, 'expected the "hypothesize" loop step');
  assert.match(content, /\btest\b/i, 'expected the "test" loop step');
  assert.match(content, /record\b[\s\S]*evidence/i, 'expected the "record evidence" loop step');
  assert.match(
    content,
    /update[\s\S]*hypothesis[\s\S]*status/i,
    'expected the "update hypothesis status" step'
  );
  assert.match(content, /re-?focus/i, 'expected the "re-focus" loop step');
});

test('debugger.md covers all three modes: investigate, diagnose, continue', () => {
  const content = readDebuggerMd();
  assert.match(content, /\binvestigate\b/, 'expected the "investigate" mode');
  assert.match(content, /\bdiagnose\b/, 'expected the "diagnose" mode');
  assert.match(content, /\bcontinue\b/, 'expected the "continue" mode');
});

test('continue resumes from the checkpoint and never re-tests a TESTED hypothesis', () => {
  const content = readDebuggerMd();
  // Resume from the existing file / ## Current Focus.
  assert.match(
    content,
    /resume[\s\S]*##\s*Current Focus|##\s*Current Focus[\s\S]*resume/i,
    'expected continue mode to resume from ## Current Focus'
  );
  // Never re-test a hypothesis already marked TESTED.
  assert.match(
    content,
    /never\s+re-?test[\s\S]*TESTED/i,
    'expected the "never re-test a TESTED hypothesis" rule'
  );
  // On low context, checkpoint ## Current Focus + the updated date, then exit cleanly.
  assert.match(content, /low[\s-]?context/i, 'expected a low-context checkpoint rule');
  assert.match(content, /\bupdated\b/i, 'expected the checkpoint to rewrite the "updated" date');
  assert.match(content, /exit\s+cleanly/i, 'expected the "exit cleanly" checkpoint rule');
});

test('diagnose mode records a root cause and applies no fix', () => {
  const content = readDebuggerMd();
  assert.match(content, /root[\s-]?cause/i, 'expected diagnose mode to record a root cause');
  assert.match(
    content,
    /applies\s+no\s+(?:code\s+)?fix|no\s+(?:code\s+)?fix\s+(?:is\s+)?applied|without\s+applying\s+(?:a|any)\s+fix|does\s+not\s+apply\s+(?:a|any)?\s*fix/i,
    'expected diagnose mode to apply NO fix'
  );
  assert.match(content, /status:\s*diagnosed/i, 'expected diagnose to set status: diagnosed');
});

test('debugger.md sets status: resolved with root cause + fix on non-diagnose completion', () => {
  const content = readDebuggerMd();
  assert.match(content, /status:\s*resolved/i, 'expected a resolved terminal status');
  assert.match(
    content,
    /\bfix\b/i,
    'expected the resolved status to record the applied/proposed fix'
  );
});

test('debugger.md restricts I/O to .debug-session.md and the code under investigation', () => {
  const content = readDebuggerMd();
  assert.match(
    content,
    /\.debug-session\.md/,
    'expected the agent to reference the .debug-session.md file'
  );
  assert.match(
    content,
    /code under (?:investigation|test)/i,
    'expected the agent to reference the code under investigation'
  );
});
