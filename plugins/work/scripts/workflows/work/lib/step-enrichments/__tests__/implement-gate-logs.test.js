/**
 * Regression: implement-gate must persist full test stdout/stderr to a
 * per-task `logs/<phase>-<timestamp>.log` file (alongside tdd-phase.json),
 * with a pointer (`logPath`, `logBytes`) recorded in the evidence JSON.
 *
 * Today the JSON only carries a 2–4 KB `outputTail`. ECHO-4573 dropped
 * meaningful test output (Prisma trigger noise alone filled the tail).
 * Full logs let later steps (review, follow-up) read the complete run.
 *
 * Retention is bounded to LOG_RETENTION_COUNT entries per task.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runPreImplementTest, runTestAndRecord } = require('../implement-gate');

function readEvidence(gateTasksBase, safe, taskNum) {
  const p = path.join(gateTasksBase, safe, `task${taskNum}`, 'tdd-phase.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('implement-gate: persist full test logs', () => {
  it('runPreImplementTest writes red log file and records logPath', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-logs-'));
    try {
      const gateTasksBase = path.join(tmp, 'tasks');
      const safe = 'ECHO-LOGS';
      const taskNum = 1;
      const wd = path.join(tmp, 'wd');
      fs.mkdirSync(wd, { recursive: true });

      // Failing command that emits a recognizable token to stdout.
      const cmd = "printf 'PRE_TEST_OUTPUT_MARKER\\n' && exit 1";
      runPreImplementTest(cmd, safe, taskNum, wd, process.env, gateTasksBase, 'feature');

      const ev = readEvidence(gateTasksBase, safe, taskNum);
      const red = ev.cycles[0].red;
      assert.equal(red.testExitCode, 1);
      assert.ok(red.logPath, 'red.logPath should be set');
      assert.match(red.logPath, /^logs\/red-.*\.log$/);
      assert.ok(red.logBytes > 0);

      const taskDir = path.dirname(
        path.join(gateTasksBase, safe, `task${taskNum}`, 'tdd-phase.json')
      );
      const fullLog = fs.readFileSync(path.join(taskDir, red.logPath), 'utf8');
      assert.match(fullLog, /PRE_TEST_OUTPUT_MARKER/);
      assert.match(fullLog, /# command:/);
      assert.match(fullLog, /# exitCode: 1/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runTestAndRecord writes green log file when appending to existing red', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-logs-'));
    try {
      const gateTasksBase = path.join(tmp, 'tasks');
      const safe = 'ECHO-LOGS';
      const taskNum = 1;
      const wd = path.join(tmp, 'wd');
      fs.mkdirSync(wd, { recursive: true });
      const taskDir = path.join(gateTasksBase, safe, `task${taskNum}`);
      fs.mkdirSync(taskDir, { recursive: true });

      // Seed an existing RED so runTestAndRecord takes the "append" branch.
      fs.writeFileSync(
        path.join(taskDir, 'tdd-phase.json'),
        JSON.stringify({
          currentPhase: 'red',
          currentCycle: 1,
          cycles: [{ cycle: 1, red: { testCommand: 'x', testExitCode: 1, timestamp: 'x' } }],
        })
      );

      const cmd = "printf 'POST_TEST_GREEN_MARKER\\n' && exit 0";
      const res = runTestAndRecord(cmd, safe, taskNum, wd, process.env, gateTasksBase);
      assert.equal(res.passed, true);

      const ev = readEvidence(gateTasksBase, safe, taskNum);
      const green = ev.cycles[0].green;
      assert.ok(green.logPath, 'green.logPath should be set');
      assert.match(green.logPath, /^logs\/green-.*\.log$/);
      assert.ok(green.logBytes > 0);

      const fullLog = fs.readFileSync(path.join(taskDir, green.logPath), 'utf8');
      assert.match(fullLog, /POST_TEST_GREEN_MARKER/);
      assert.match(fullLog, /# phase: green/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('log retention prunes older files (keeps ≤ 6)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-logs-'));
    try {
      const gateTasksBase = path.join(tmp, 'tasks');
      const safe = 'ECHO-LOGS';
      const taskNum = 1;
      const wd = path.join(tmp, 'wd');
      fs.mkdirSync(wd, { recursive: true });
      const taskDir = path.join(gateTasksBase, safe, `task${taskNum}`);
      fs.mkdirSync(taskDir, { recursive: true });

      // Run 10 failing pre-tests; only ≤6 logs should survive.
      const cmd = "printf 'X\\n' && exit 1";
      for (let i = 0; i < 10; i++) {
        runPreImplementTest(cmd, safe, taskNum, wd, process.env, gateTasksBase, 'feature');
        // Sleep is forbidden; rely on ISO timestamp millisecond precision
        // — these 10 calls are fast enough to collide if same ms, but writeFileSync
        // is sync and Date.now() advances enough on most runs. If they collide,
        // we just overwrite and the test asserts <=6 which still holds.
      }

      const logsDir = path.join(taskDir, 'logs');
      const entries = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
      assert.ok(entries.length <= 6, `expected ≤6 log files, got ${entries.length}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
