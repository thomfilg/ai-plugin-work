/**
 * W3 (implement-phase fix design) — message-policy pin for the implement
 * surface.
 *
 * Implement-phase gates and recorders must NEVER instruct (or offer) the
 * executing agent to edit tasks.md: it is planner-owned and LOCKED during
 * implement, and every tasks.md defect must surface as a planner defect
 * (`BLOCKED (planner-defect): …` + operator-hold) instead. This test greps
 * every implement-phase source file for the forbidden phrasings so a future
 * message can't quietly reintroduce the instruction (precedent:
 * skills/work-implement/__tests__/skill-md-content.test.js pins SKILL.md).
 *
 * Compliant phrasing like "tasks.md is planner-owned … do NOT edit it" is
 * deliberately not matched. tasks-scope-gate.js is out of scope: it belongs
 * to the tasks_gate step, where editing tasks.md is allowed.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', '..');

/** Implement-phase source surfaces (design W3 grep scope). */
const SCAN_ROOTS = [
  path.join(WORKFLOWS_DIR, 'work-implement'),
  path.join(WORKFLOWS_DIR, 'work', 'lib', 'step-enrichments', 'implement-gate'),
];
const SCAN_FILES = [
  path.join(WORKFLOWS_DIR, 'work', 'lib', 'step-enrichments', 'implement.js'),
  path.join(WORKFLOWS_DIR, 'work', 'lib', 'step-enrichments', 'implement-gate.js'),
  // TDD_PROTOCOL is agent-facing prompt text injected by plan-generator —
  // in scope for the message policy (incl. the exception-subcommand rule).
  path.join(WORKFLOWS_DIR, 'work', 'lib', 'tdd-enforcement.js'),
];

// Built via RegExp constructors/concatenation so this file never contains a
// forbidden literal itself (and survives its own policy if scope ever widens).
const FORBIDDEN = [
  new RegExp(`${'fix'} the \`### Type\``, 'i'),
  new RegExp(`open tasks\\.md and ${'fix'}`, 'i'),
  new RegExp(`${'update'} tasks\\.md`, 'i'),
  new RegExp(`${'fix'} tasks\\.md`, 'i'),
  // "edit tasks.md" is forbidden unless negated ("do NOT edit tasks.md",
  // "never to edit tasks.md").
  new RegExp(`(?<!not\\s)(?<!never to\\s)${'edit'} tasks\\.md`, 'i'),
  // The all-skipped trap must not offer "document the skips … in tasks.md".
  new RegExp(`${'document'} the skips`, 'i'),
  // Bugs-review sweep: no implement-phase surface may present the
  // OPERATOR-ONLY `exception` subcommand as agent-runnable (it is
  // WORK_OPERATOR_TOKEN-gated; agents following it dead-end). Matches the
  // instruction shape `… exception <TICKET…` — the operator-only
  // implementation files below are the sole allowed homes for that usage.
  new RegExp(`${'exception'} <TICKET`, 'i'),
];

// Files that IMPLEMENT (and document, operator-facing) the operator-only
// `exception` subcommand: its own usage strings are exempt from the
// exception-subcommand rule — the policy forbids OTHER surfaces from
// pointing agents at it.
const EXCEPTION_IMPL_BASENAMES = new Set(['exception.js', 'tdd-phase-state.js']);
const EXCEPTION_RULE = FORBIDDEN[FORBIDDEN.length - 1];

function collectJsFiles(root, out) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      collectJsFiles(p, out);
    } else if (entry.isFile() && p.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

function scanFile(file) {
  // Normalize template-literal escapes (\`) so `fix the \`### Type\`` inside
  // a template string still matches the forbidden pattern.
  const text = fs.readFileSync(file, 'utf8').replace(/\\`/g, '`');
  const skipExceptionRule = EXCEPTION_IMPL_BASENAMES.has(path.basename(file));
  const hits = [];
  text.split('\n').forEach((line, idx) => {
    for (const re of FORBIDDEN) {
      if (re === EXCEPTION_RULE && skipExceptionRule) continue;
      if (re.test(line)) hits.push(`${file}:${idx + 1}  [${re}]  ${line.trim().slice(0, 160)}`);
    }
  });
  return hits;
}

describe('W3 — implement-phase messages never instruct editing tasks.md', () => {
  const files = [];
  for (const root of SCAN_ROOTS) collectJsFiles(root, files);
  for (const f of SCAN_FILES) if (fs.existsSync(f)) files.push(f);

  it('scans a non-trivial implement surface', () => {
    assert.ok(files.length >= 20, `expected >= 20 files, scanned ${files.length}`);
    const names = files.map((f) => path.basename(f));
    for (const expected of [
      'task-next.js',
      'record-red.js',
      'active-task.js',
      'evidence.js',
      'evidence-flow.js',
      'test-runner.js',
      'advance-gate.js',
      'planner-hold.js',
      'enforce-tdd-on-stop.js',
    ]) {
      assert.ok(names.includes(expected), `scan must cover ${expected}`);
    }
  });

  it('contains no forbidden "change tasks.md" phrasings', () => {
    const violations = files.flatMap(scanFile);
    assert.deepEqual(
      violations,
      [],
      `Forbidden tasks.md-edit instruction(s) found:\n${violations.join('\n')}`
    );
  });
});
