/**
 * End-to-end integration test for the /check `7_validate_summary` step.
 *
 * Exercises the whole validator path against a fixture tasks folder, proving
 * Tasks 1–4 compose correctly:
 *   - gherkin §6 — /check fails loudly when an expected report is silently lost
 *     (delete one expected report mid-flight → validator exits non-zero, writes
 *     `check-missing-report.diag.json`, and surfaces a top-level `missingReports`
 *     entry so auto-advance to `8_output` is refused).
 *   - gherkin §7 — /check completes cleanly when reports persist (all expected
 *     reports present → validator exits zero, writes no diag artifact, and the
 *     workflow advances cleanly).
 *
 * The validator is spawned as a subprocess exactly as the workflow invokes it,
 * with `TASKS_BASE` pointed at an isolated tmp dir (no fixture leakage).
 *
 * node:test + node:assert/strict. CommonJS only.
 * Run: node --test .../check-validate-reports.e2e.integration.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'hooks', 'check-validate-reports.js');
const TICKET = 'GH-FIXTURE';
const IMPACTED_APPS = ['web', 'api'];
const DIAG_FILENAME = 'check-missing-report.diag.json';

// The canonical reports the validator must find for this fixture. Mirrors the
// gherkin §5 canonical set for impactedApps=['web','api'] with backend changes.
const EXPECTED_REPORTS = [
  'code-review.check.md',
  'tests.check.md',
  'completion.check.md',
  'qa-web.check.md',
  'qa-api.check.md',
];

/** Per-test isolated tmp tasks-base + ticket folder. */
let tasksBase;
let ticketFolder;

/** Build a minimal QA report that passes content validation. */
function buildQAReport() {
  return [
    '**Changes Hash:** abc123',
    '',
    'Status: APPROVED',
    '',
    '## Playwright Verification',
    '',
    '![screenshot](./screenshots/test.png)',
    '',
  ].join('\n');
}

/** Write every expected report (and README) so the folder is fully populated. */
function writeAllReports(folder) {
  fs.writeFileSync(path.join(folder, 'code-review.check.md'), '**Changes Hash:** x\nNo issues');
  fs.writeFileSync(path.join(folder, 'tests.check.md'), '**Changes Hash:** x\n✅ PASS');
  fs.writeFileSync(path.join(folder, 'completion.check.md'), '**Changes Hash:** x\nCOMPLETE');
  fs.writeFileSync(path.join(folder, 'qa-web.check.md'), buildQAReport());
  fs.writeFileSync(path.join(folder, 'qa-api.check.md'), buildQAReport());
  fs.writeFileSync(path.join(folder, 'README.md'), 'readme');
}

/**
 * Run the validator exactly as the workflow does and return parsed JSON + exit
 * code. TASKS_BASE points at the isolated fixture base.
 */
function runValidator(reportFolder, impactedApps) {
  try {
    const stdout = execFileSync('node', [SCRIPT, reportFolder, JSON.stringify(impactedApps)], {
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, TASKS_BASE: tasksBase },
    });
    return { exitCode: 0, result: safeParse(stdout) };
  } catch (err) {
    return { exitCode: err.status, result: safeParse((err.stdout || '').toString()) };
  }
}

function safeParse(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (_) {
    return null;
  }
}

beforeEach(() => {
  tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'check-e2e-'));
  ticketFolder = path.join(tasksBase, TICKET);
  fs.mkdirSync(ticketFolder, { recursive: true });
});

afterEach(() => {
  if (tasksBase) {
    fs.rmSync(tasksBase, { recursive: true, force: true });
    tasksBase = undefined;
  }
});

describe('check-validate-reports.js — end-to-end /check validate_summary step', () => {
  it('/check completes cleanly when reports persist', () => {
    writeAllReports(ticketFolder);

    const { exitCode, result } = runValidator(ticketFolder, IMPACTED_APPS);

    // Clean success: validator exits zero so the workflow advances to 8_output.
    assert.equal(exitCode, 0, 'validator must exit 0 when every expected report persists');
    assert.ok(result, 'validator must emit parseable JSON output');
    assert.ok(result.overall.valid, 'overall.valid must be true on clean success');

    // No missing reports surfaced and no diag artifact written.
    assert.deepEqual(
      result.missingReports || [],
      [],
      'missingReports must be empty when all reports persist'
    );
    assert.ok(
      !fs.existsSync(path.join(ticketFolder, DIAG_FILENAME)),
      'no diag artifact must be written on clean success'
    );
  });

  it('/check fails loudly when an expected report is silently lost', () => {
    // Start from a fully-populated folder, then simulate a background-agent
    // silent loss by deleting one expected report mid-flight.
    writeAllReports(ticketFolder);
    const lost = path.join(ticketFolder, 'tests.check.md');
    fs.rmSync(lost);
    assert.ok(!fs.existsSync(lost), 'precondition: tests.check.md is gone');

    const { exitCode, result } = runValidator(ticketFolder, IMPACTED_APPS);

    // Hard fail: non-zero exit refuses auto-advance to 8_output.
    assert.notEqual(exitCode, 0, 'validator must exit non-zero when an expected report is lost');
    assert.ok(result, 'validator must still emit parseable JSON output on failure');

    // Top-level missingReports surfaces the offending filename.
    assert.ok(
      Array.isArray(result.missingReports),
      'result must include a top-level missingReports array'
    );
    assert.ok(
      result.missingReports.includes('tests.check.md'),
      `missingReports must name the silently-lost report, got: ${JSON.stringify(
        result.missingReports
      )}`
    );

    // Diag artifact is written into the ticket folder with the required keys.
    const diagPath = path.join(ticketFolder, DIAG_FILENAME);
    assert.ok(fs.existsSync(diagPath), `diag artifact must exist at ${DIAG_FILENAME}`);
    const diag = JSON.parse(fs.readFileSync(diagPath, 'utf-8'));
    assert.ok(
      Array.isArray(diag.missingReports) && diag.missingReports.includes('tests.check.md'),
      'diag artifact must record the missing report name'
    );
    assert.ok(diag.timestamp, 'diag artifact must record an ISO timestamp');
    assert.ok(diag.env && typeof diag.env === 'object', 'diag artifact must record whitelisted env');
    // Security: env must be whitelisted, never a wholesale dump of process.env.
    const envKeys = Object.keys(diag.env);
    assert.ok(
      envKeys.every((k) => ['CLAUDE_PLUGIN_ROOT', 'TASKS_BASE', 'PWD'].includes(k)),
      `diag env must be whitelisted, got keys: ${envKeys.join(', ')}`
    );
  });
});
