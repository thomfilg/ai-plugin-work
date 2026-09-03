/**
 * check-gate.js — Check-to-PR transition gate (GH-121)
 *
 * Declarative array of rules that must ALL pass before the orchestrator
 * allows a check → pr transition.  Each rule returns an array of failure
 * reasons (empty = pass).
 *
 * Mirrors the { step, verify } pattern in enforce-step-workflow.js.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const config = require(path.join(__dirname, '..', '..', 'lib', 'config'));
const { parseReportStatus, isCodeReviewResolved } = require('../../lib/parse-report-status');
const { STEPS } = require(path.join(__dirname, '..', 'step-registry'));
const { staleEvidenceFiles } = require(path.join(__dirname, '..', 'lib', 'evidence-staleness'));
const { isOutcomeMode } = require(path.join(__dirname, '..', '..', 'lib', 'tdd-mode'));

// ─── Helpers (local, no external deps) ──────────────────────────────────────

// Helpers — extracted as-is from hooks/work-orchestrator.js to preserve identical behavior
function fileExists(p) {
  return fs.existsSync(p);
}
function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Parse execFileSync error from spec-verify.js execution.
 * @param {Error & { stdout?: string, stderr?: string }} err
 * @returns {string[]}
 */
function streamToString(value, trim) {
  let str;
  if (typeof value === 'string') str = value;
  else if (Buffer.isBuffer(value)) str = value.toString();
  else return '';
  return trim ? str.trim() : str;
}

/** One reason line per failed spec check. Shared by the rule and its error path. */
function formatSpecFailures(checks) {
  return checks
    .filter((c) => !c.passed)
    .map(
      (c) =>
        `Spec verification failed: ${c.type} ${Array.isArray(c.args) ? c.args.join(' ') : ''} — ${c.reason || 'check failed'}`
    );
}

function parseSpecVerifyStdout(stdout) {
  try {
    const result = JSON.parse(stdout);
    if (typeof result.success !== 'boolean' || result.success || !Array.isArray(result.checks)) {
      return null;
    }
    const failures = formatSpecFailures(result.checks);
    return failures.length > 0
      ? failures
      : ['Spec verification failed but no specific check details available'];
  } catch {
    return null;
  }
}

function parseSpecVerifyError(err) {
  const stdout = streamToString(err.stdout, false);
  const stderr = streamToString(err.stderr, true);
  if (stdout) {
    const parsed = parseSpecVerifyStdout(stdout);
    if (parsed) return parsed;
  }
  return [`Spec verification script error: ${stderr || err.message || 'unknown error'}`];
}

function listFiles(dir, pattern) {
  if (!fileExists(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => (pattern instanceof RegExp ? pattern.test(f) : f.includes(pattern)))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// ─── required-reports helpers ───────────────────────────────────────────────

const REQUIRED_CHECK_REPORTS = [
  { file: 'tests.check.md', type: 'tests' },
  { file: 'code-review.check.md', type: 'codeReview' },
  { file: 'completion.check.md', type: 'completion' },
];

/**
 * Code-review reply reconciliation. An APPROVED report is accepted regardless
 * of reply-file state; otherwise a reply may clear the CRITICAL/IMPORTANT
 * issues the report raised.
 *
 * @returns {string|null|undefined} a failure reason, `null` to accept, or
 *   `undefined` to fall through to the standard status check.
 */
function codeReviewReason(dir, req, content, status) {
  if (status === 'APPROVED') return null;
  const replyPath = path.join(dir, 'code-review-reply.check.md');
  if (!fileExists(replyPath)) return undefined; // no reply file — status decides
  const resolution = isCodeReviewResolved(content, readFile(replyPath));
  // blockingCount === 0: no CRITICAL/IMPORTANT issues found in the report, so
  // the reply file cannot bypass a non-APPROVED status.
  if (resolution.blockingCount === 0) return undefined;
  if (resolution.resolved) return null; // blocking issues all addressed
  return `Report ${req.file} has unresolved issues: ${resolution.unaddressed.join(', ')}`;
}

/** One required report's verdict: a failure reason, or null when it passes. */
function requiredReportReason(dir, req) {
  const fp = path.join(dir, req.file);
  if (!fileExists(fp)) return `Missing report: ${req.file}`;
  const content = readFile(fp);
  // Guard: empty/whitespace content cannot pass any gate
  if (!content || !content.trim()) return `Report ${req.file} is empty`;

  const { status } = parseReportStatus(content, req.type);
  if (req.type === 'codeReview') {
    const verdict = codeReviewReason(dir, req, content, status);
    if (verdict !== undefined) return verdict;
  }
  // Status line is the authoritative gate when no blocking issues exist
  if (status === 'APPROVED') return null;
  return `Report ${req.file} status is ${status} (expected APPROVED)`;
}

/**
 * OUTCOME MODE (the WORK_TDD_MODE default) equivalent of per-task TDD
 * evidence: there is no tdd-phase.json to read — the boundary verifier's
 * verdict IS the per-task proof, and what it could not verify it recorded as
 * a flag on the work state. Unresolved flags block here exactly as missing
 * evidence does in process mode (plan §5.5).
 */
function outcomeFlagReasons(dir) {
  const { unresolvedOutcomeFlags, describeUnresolvedFlags } = require(
    path.join(__dirname, '..', '..', 'check', 'lib', 'outcome-flags')
  );
  const unresolved = unresolvedOutcomeFlags(dir);
  if (unresolved.length === 0) return [];
  return [`Unresolved outcome-verifier flags — ${describeUnresolvedFlags(unresolved)}`];
}

/** One task's TDD evidence verdict: a failure reason, or null when it passes. */
function taskTddReason(dir, task, validateTddEvidenceForType) {
  const taskName = `task${task.num}`;
  const tddPath = path.join(dir, taskName, 'tdd-phase.json');
  if (!fileExists(tddPath)) return `Missing TDD evidence: ${taskName}/tdd-phase.json`;
  try {
    const state = JSON.parse(readFile(tddPath));
    const validation = validateTddEvidenceForType(state, task.type);
    return validation.valid ? null : `${taskName}/tdd-phase.json: ${validation.reason}`;
  } catch (e) {
    const detail = e instanceof SyntaxError ? 'invalid JSON' : e?.message || 'read error';
    return `${taskName}/tdd-phase.json: ${detail}`;
  }
}

// ─── Gate Rules ─────────────────────────────────────────────────────────────

const CHECK_GATE_RULES = [
  {
    name: 'evidence-freshness',
    description:
      'Check reports invalidated by a loop-back or HEAD drift must be rewritten by /check',
    check(dir) {
      // echo-6842: this rule carries what archival used to enforce by moving
      // the reports away. They stay put now, so the gate has to say why it is
      // refusing them — "stale" reads very differently from "missing" when
      // the drift signal that invalidated them was itself wrong.
      const stale = staleEvidenceFiles(dir, STEPS.check);
      if (stale.length === 0) return [];
      return [
        `Check reports are stale (not rewritten since the step was re-opened): ${stale.join(', ')}. ` +
          'Re-run /check — the previous reports are still readable in place.',
      ];
    },
  },
  {
    name: 'required-reports',
    description:
      'All required .check.md reports must exist with accepted status (APPROVED or COMPLETE)',
    check(dir) {
      return REQUIRED_CHECK_REPORTS.map((req) => requiredReportReason(dir, req)).filter(Boolean);
    },
  },
  {
    name: 'qa-reports',
    description:
      'At least one qa-*.check.md must exist when web apps are configured; all must have Status: APPROVED or NOT_APPLICABLE',
    check(dir) {
      // Skip QA requirement when no web apps are configured (GH-181)
      if (config.webAppNames().length === 0) {
        return [];
      }
      const qaFiles = listFiles(dir, /^qa-.*\.check\.md$/);
      if (qaFiles.length === 0) return ['No QA reports found (need at least one qa-*.check.md)'];
      const reasons = [];
      for (const f of qaFiles) {
        const { status } = parseReportStatus(readFile(f), 'qa');
        if (status !== 'APPROVED' && status !== 'NOT_APPLICABLE') {
          reasons.push(
            `QA report ${path.basename(f)} has status ${status} (expected APPROVED or NOT_APPLICABLE)`
          );
        }
      }
      return reasons;
    },
  },
  {
    name: 'running-agents',
    description: 'No check-agent tmux sessions may be running',
    // tmux session-found path is integration-tested in work-orchestrator.test.js scenario 8
    check(_dir, ticket) {
      const agents = [
        'code-checker',
        'quality-checker',
        'completion-checker',
        'qa-feature-tester',
        'qa-api-tester',
      ];
      return agents.reduce((reasons, agent) => {
        const session = `${ticket}-${agent}`;
        try {
          execFileSync('tmux', ['has-session', '-t', session], {
            timeout: 3000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          reasons.push(`Check agent still running: ${agent} (tmux session: ${session})`);
        } catch (err) {
          // exit code 1 = session not found (expected). Log other failures for debugging.
          if (!(err && typeof err.status === 'number' && err.status === 1) && err) {
            const d = [
              err.status != null && `status=${err.status}`,
              err.signal != null && `signal=${err.signal}`,
              err.code && `code=${err.code}`,
            ].filter(Boolean);
            process.stderr.write(
              `check-gate: tmux check failed for ${session}${d.length ? ` (${d.join(', ')})` : ''}\n`
            );
          }
        }
        return reasons;
      }, []);
    },
  },
  {
    name: 'per-task-tdd-evidence',
    description:
      'All tasks must carry per-task proof when tasks.md exists (GH-259) — recorded TDD ' +
      'evidence in process/shadow mode, no unresolved verifier flags in outcome mode',
    check(dir) {
      const tasksPath = path.join(dir, 'tasks.md');
      if (!fileExists(tasksPath)) return []; // single-task mode, skip
      if (isOutcomeMode()) return outcomeFlagReasons(dir);
      // ONE shared contract-aware validator (tdd-enforcement.js) — the same
      // acceptance rule the implement gate applied when it advanced each
      // task, so gate-accepted evidence can never dead-end here. ('test' is
      // not in the closed Type enum — the old `t.type !== 'test'` filter
      // exempted a nonexistent Type while strict-validating the real
      // TDD-exempt ones.)
      const { validateTddEvidenceForType } = require(
        path.join(__dirname, '..', 'lib', 'tdd-enforcement')
      );
      const taskParser = require(path.join(__dirname, '..', 'lib', 'task-parser'));
      const tasks = taskParser.parseTasks(dir);
      if (!tasks || tasks.length === 0)
        return ['Unable to parse tasks.md — cannot verify per-task TDD evidence'];
      const expectedTasks = tasks.filter((t) => !t.isCheckpoint);
      if (expectedTasks.length === 0) return []; // all checkpoint tasks
      return expectedTasks
        .map((task) => taskTddReason(dir, task, validateTddEvidenceForType))
        .filter(Boolean);
    },
  },
  {
    name: 'spec-verification',
    description: 'Spec Verification Checklist markers must all pass (fail-open for legacy specs)',
    check(dir) {
      const specPath = path.join(dir, 'spec.md');
      if (!fileExists(specPath)) return []; // fail-open: no spec = pass
      const scriptPath = path.resolve(__dirname, '..', '..', 'check', 'scripts', 'spec-verify.js');
      // Resolve worktree root — spec.md lives in the tasks dir, not the git worktree
      let worktreeRoot;
      try {
        worktreeRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } catch {
        worktreeRoot = process.cwd();
      }
      try {
        const stdout = execFileSync(
          'node',
          [scriptPath, specPath, '--json', '--root', worktreeRoot],
          {
            encoding: 'utf-8',
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe'], // worktree root resolved above via git rev-parse
          }
        );
        const result = JSON.parse(stdout);
        if (typeof result.success !== 'boolean')
          return ['Spec verification returned unexpected output format'];
        if (result.success) return [];
        if (!Array.isArray(result.checks))
          return ['Spec verification failed with no check details'];
        return formatSpecFailures(result.checks);
      } catch (err) {
        return parseSpecVerifyError(err); // delegates error handling to parseSpecVerifyError
      }
    },
  },
];

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Validate all check-gate rules for a ticket.
 * @param {string} tasksBase - Root tasks directory
 * @param {string} ticket    - Ticket ID (e.g. "PROJ-123")
 * @returns {{ valid: boolean, reasons: string[], rules: Array<{ name: string, passed: boolean, reasons: string[] }> }}
 */
function validateCheckGate(tasksBase, ticket) {
  const dir = path.join(tasksBase, ticket);
  const rules = CHECK_GATE_RULES.map((rule) => {
    const ruleReasons = rule.check(dir, ticket);
    return { name: rule.name, passed: ruleReasons.length === 0, reasons: ruleReasons };
  });
  const reasons = rules.flatMap((r) => r.reasons);
  return { valid: reasons.length === 0, reasons, rules };
}

module.exports = { CHECK_GATE_RULES, validateCheckGate };
