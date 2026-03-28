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
const fs   = require('fs');
const { execFileSync } = require('child_process');

// ─── Helpers (local, no external deps) ──────────────────────────────────────

// Helpers match the signatures in hooks/work-orchestrator.js (extracted as-is)
function fileExists(p) { try { return fs.existsSync(p); } catch { return false; } }
function readFile(p)   { try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; } }

function listFiles(dir, pattern) {
  if (!fileExists(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => pattern instanceof RegExp ? pattern.test(f) : f.includes(pattern))
      .map(f => path.join(dir, f));
  } catch { return []; }
}

// ─── Gate Rules ─────────────────────────────────────────────────────────────

const CHECK_GATE_RULES = [
  {
    name: 'required-reports',
    description: 'All required .check.md reports must exist with accepted status (APPROVED or COMPLETE)',
    check(dir) {
      const required = [
        { file: 'tests.check.md',       pattern: /Status:\s*APPROVED/i },
        { file: 'code-review.check.md', pattern: /Status:\s*APPROVED/i },
        { file: 'completion.check.md',  pattern: /Status:\s*(COMPLETE|APPROVED)/i },
      ];
      const reasons = [];
      for (const req of required) {
        const fp = path.join(dir, req.file);
        if (!fileExists(fp)) { reasons.push(`Missing report: ${req.file}`); continue; }
        if (!req.pattern.test(readFile(fp))) {
          reasons.push(`Report ${req.file} does not contain the required Status: line`);
        }
      }
      return reasons;
    },
  },
  {
    name: 'qa-reports',
    description: 'At least one qa-*.check.md must exist, all must have Status: APPROVED',
    check(dir) {
      const qaFiles = listFiles(dir, /^qa-.*\.check\.md$/);
      if (qaFiles.length === 0) return ['No QA reports found (need at least one qa-*.check.md)'];
      return qaFiles
        .filter(f => !/Status:\s*APPROVED/i.test(readFile(f)))
        .map(f => `QA report ${path.basename(f)} does not have Status: APPROVED`);
    },
  },
  {
    name: 'running-agents',
    description: 'No check-agent tmux sessions may be running',
    check(_dir, ticket) {
      const agents = ['code-checker', 'quality-checker', 'completion-checker', 'qa-feature-tester', 'qa-api-tester'];
      const reasons = [];
      for (const agent of agents) {
        const sessionName = `${ticket}-${agent}`;
        try {
          execFileSync('tmux', ['has-session', '-t', sessionName], {
            timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
          });
          reasons.push(`Check agent still running: ${agent} (tmux session: ${sessionName})`);
        } catch (err) {
          // exit code 1 = session not found (expected). Log other failures for debugging.
          const isSessionNotFound = err && typeof err.status === 'number' && err.status === 1;
          if (!isSessionNotFound && err) {
            const details = [];
            if (err.status != null) details.push(`status=${err.status}`);
            if (err.signal != null) details.push(`signal=${err.signal}`);
            if (err.code) details.push(`code=${err.code}`);
            process.stderr.write(
              `check-gate: tmux has-session check failed for ${sessionName}` +
              (details.length ? ` (${details.join(', ')})` : '') + '\n'
            );
          }
        }
      }
      return reasons;
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
  const reasons = CHECK_GATE_RULES.flatMap(rule => rule.check(dir, ticket));
  return { valid: reasons.length === 0, reasons };
}

module.exports = { CHECK_GATE_RULES, validateCheckGate };
