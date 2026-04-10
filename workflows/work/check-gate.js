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
const config = require(path.join(__dirname, '..', 'lib', 'config'));

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
function parseSpecVerifyError(err) {
  const stdout =
    typeof err.stdout === 'string'
      ? err.stdout
      : Buffer.isBuffer(err.stdout)
        ? err.stdout.toString()
        : '';
  const stderr =
    typeof err.stderr === 'string'
      ? err.stderr.trim()
      : Buffer.isBuffer(err.stderr)
        ? err.stderr.toString().trim()
        : '';
  if (stdout) {
    try {
      const result = JSON.parse(stdout);
      if (typeof result.success === 'boolean' && !result.success && Array.isArray(result.checks)) {
        const failures = result.checks
          .filter((c) => !c.passed)
          .map(
            (c) =>
              `Spec verification failed: ${c.type} ${Array.isArray(c.args) ? c.args.join(' ') : ''} — ${c.reason || 'check failed'}`
          );
        return failures.length > 0
          ? failures
          : ['Spec verification failed but no specific check details available'];
      }
    } catch {
      /* stdout wasn't valid JSON, fall through to generic error */
    }
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

// ─── Gate Rules ─────────────────────────────────────────────────────────────

const CHECK_GATE_RULES = [
  {
    name: 'required-reports',
    description:
      'All required .check.md reports must exist with accepted status (APPROVED or COMPLETE)',
    check(dir) {
      const required = [
        { file: 'tests.check.md', pattern: /Status:\s*\*{0,2}\s*APPROVED/i },
        { file: 'code-review.check.md', pattern: /Status:\s*\*{0,2}\s*APPROVED/i },
        { file: 'completion.check.md', pattern: /Status:\s*\*{0,2}\s*(COMPLETE|APPROVED)/i },
      ];
      const reasons = [];
      for (const req of required) {
        const fp = path.join(dir, req.file);
        if (!fileExists(fp)) {
          reasons.push(`Missing report: ${req.file}`);
          continue;
        }
        if (!req.pattern.test(readFile(fp))) {
          reasons.push(`Report ${req.file} does not contain the required Status: line`);
        }
      }
      return reasons;
    },
  },
  {
    name: 'qa-reports',
    description:
      'At least one qa-*.check.md must exist when web apps are configured; all must have Status: APPROVED',
    check(dir) {
      // Skip QA requirement when no web apps are configured (GH-181)
      if (config.webAppNames().length === 0) {
        return [];
      }
      const qaFiles = listFiles(dir, /^qa-.*\.check\.md$/);
      if (qaFiles.length === 0) return ['No QA reports found (need at least one qa-*.check.md)'];
      return qaFiles
        .filter((f) => !/Status:\s*\*{0,2}\s*APPROVED/i.test(readFile(f)))
        .map((f) => `QA report ${path.basename(f)} does not have Status: APPROVED`); // regex on line above handles bold markdown
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
    name: 'spec-verification',
    description: 'Spec Verification Checklist markers must all pass (fail-open for legacy specs)',
    check(dir) {
      const specPath = path.join(dir, 'spec.md');
      if (!fileExists(specPath)) return []; // fail-open: no spec = pass
      const scriptPath = path.resolve(__dirname, '..', 'check', 'scripts', 'spec-verify.js');
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
        return result.checks
          .filter((c) => !c.passed)
          .map(
            (c) =>
              `Spec verification failed: ${c.type} ${Array.isArray(c.args) ? c.args.join(' ') : ''} — ${c.reason || 'check failed'}`
          );
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
 * @returns {{ valid: boolean, reasons: string[] }}
 */
function validateCheckGate(tasksBase, ticket) {
  const dir = path.join(tasksBase, ticket);
  const reasons = CHECK_GATE_RULES.flatMap((rule) => rule.check(dir, ticket));
  return { valid: reasons.length === 0, reasons };
}

module.exports = { CHECK_GATE_RULES, validateCheckGate };
