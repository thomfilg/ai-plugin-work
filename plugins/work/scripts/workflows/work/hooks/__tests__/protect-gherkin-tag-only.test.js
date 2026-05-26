/**
 * Tests for protect-gherkin.js tag-only edit allow-path (GH-392 Task 6, P0 #5).
 *
 * During `implement`, Edit/MultiEdit operations on gherkin.feature whose diff
 * touches ONLY tag lines (matching /^\s*(@[\w:-]+\s*)+$/) must exit 0.
 * Semantic edits (Scenario/Given/When/Then/And/Feature lines) must continue
 * to exit 2, and stderr must end with a `BYPASS:` line pointing at the
 * `spec_gate` recovery path. Ambiguous diffs (mixed tag + semantic) default
 * to block to preserve the security invariant.
 *
 * Run with:
 *   node --test scripts/workflows/work/hooks/__tests__/protect-gherkin-tag-only.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'protect-gherkin.js');

function createStateFixture(ticketId, stepStatus = {}) {
  const tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-tag-test-'));
  const ticketDir = path.join(tasksBase, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });

  const defaultStepStatus = {
    ticket: 'completed',
    bootstrap: 'completed',
    brief: 'completed',
    spec: 'completed',
    tasks: 'completed',
    implement: 'in_progress',
    commit: 'pending',
    task_review: 'pending',
    check: 'pending',
    pr: 'pending',
  };

  const state = {
    ticketId,
    status: 'in_progress',
    stepStatus: { ...defaultStepStatus, ...stepStatus },
    startTime: new Date().toISOString(),
    lastUpdate: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(ticketDir, '.work-state.json'), JSON.stringify(state, null, 2));

  return {
    tasksBase,
    ticketDir,
    cleanup: () => fs.rmSync(tasksBase, { recursive: true, force: true }),
  };
}

function runHook(input, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...envOverrides },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      resolve({ code, stderr, stdout });
    });
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

function runHookWithState(input, ticketId, stepStatus = {}, envExtras = {}) {
  const fixture = createStateFixture(ticketId, stepStatus);
  const env = {
    TASKS_BASE: fixture.tasksBase,
    TICKET_ID: ticketId,
    ...envExtras,
  };
  return runHook(input, env).finally(() => fixture.cleanup());
}

describe('protect-gherkin tag-only allow-path (P0 #5)', () => {
  it('P0 #5 — tag-only Gherkin edits allowed during implement', async () => {
    // Edit changes only a tag line: @wip -> @regression. Should exit 0.
    const { code, stderr } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: {
          file_path: '/home/user/project/tasks/GH-99/gherkin.feature',
          old_string: '  @wip\n  Scenario: ticket fetched\n    Given an open ticket',
          new_string: '  @regression\n  Scenario: ticket fetched\n    Given an open ticket',
        },
      },
      'GH-99',
      { implement: 'in_progress', spec: 'completed' }
    );
    assert.strictEqual(
      code,
      0,
      `Expected exit 0 (allow tag-only edit) during implement, got ${code}. stderr: ${stderr}`
    );
  });

  it('P0 #5 — semantic Gherkin edits still blocked during implement', async () => {
    // Edit changes a Scenario: line. Should exit 2 with BYPASS line on stderr.
    const { code, stderr } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: {
          file_path: '/home/user/project/tasks/GH-99/gherkin.feature',
          old_string: '  @regression\n  Scenario: ticket fetched\n    Given an open ticket',
          new_string: '  @regression\n  Scenario: ticket retrieved\n    Given an open ticket',
        },
      },
      'GH-99',
      { implement: 'in_progress', spec: 'completed' }
    );
    assert.strictEqual(
      code,
      2,
      `Expected exit 2 (block semantic edit) during implement, got ${code}. stderr: ${stderr}`
    );
    const lines = stderr.trimEnd().split('\n');
    const lastLine = lines[lines.length - 1] || '';
    assert.ok(
      lastLine.startsWith('BYPASS:'),
      `Expected stderr to END with a BYPASS: line. Last line was: ${JSON.stringify(lastLine)}\nFull stderr: ${stderr}`
    );
    assert.ok(
      /spec_gate/.test(lastLine),
      `Expected BYPASS line to reference spec_gate recovery path. Got: ${JSON.stringify(lastLine)}`
    );
  });

  it('P0 #5 — ambiguous diff (tag + semantic line) default-blocks', async () => {
    // Diff touches both a tag AND a Given line — must default-block (security invariant).
    const { code, stderr } = await runHookWithState(
      {
        tool_name: 'Edit',
        tool_input: {
          file_path: '/home/user/project/tasks/GH-99/gherkin.feature',
          old_string: '  @wip\n  Scenario: ticket fetched\n    Given an open ticket',
          new_string: '  @regression\n  Scenario: ticket fetched\n    Given a closed ticket',
        },
      },
      'GH-99',
      { implement: 'in_progress', spec: 'completed' }
    );
    assert.strictEqual(
      code,
      2,
      `Expected exit 2 (default-block ambiguous diff) during implement, got ${code}. stderr: ${stderr}`
    );
  });
});
