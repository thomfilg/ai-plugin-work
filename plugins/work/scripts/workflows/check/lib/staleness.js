/**
 * staleness.js — SHA-keyed staleness + severity assessment for /check state
 * (GH-307, echo-5213-3, echo-5804-004, echo-5808-C).
 *
 * A terminal `.check-state.json` (status complete/needs_work) is only
 * trustworthy while the code it verified is unchanged. This module answers,
 * deterministically:
 *
 *   - stale:      the current changes hash (git diff <base>...HEAD -w) or
 *                 HEAD SHA differs from what was recorded at completion →
 *                 the state must be invalidated and a fresh cycle started.
 *                 This is SHA-gated enforcement, not a bypass: a reset can
 *                 only be triggered by producing a real diff.
 *   - needs_work: SHAs match, but the latest reports at the CURRENT changes
 *                 hash parse as NEEDS_WORK → the check must NOT answer
 *                 "Already complete".
 *   - valid:      SHAs match and every present required report passes →
 *                 "still valid, nothing to do".
 *
 * Hash semantics mirror check-setup.js generateChangesHash(): 12-char
 * SHA-256 of the whitespace-insensitive diff, or 'no-changes'.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const { parseReportStatus } = require(
  path.join(__dirname, '..', '..', 'lib', 'parse-report-status')
);

// Required check reports and their parse-report-status types.
const REQUIRED_REPORTS = [
  { file: 'tests.check.md', type: 'tests' },
  { file: 'code-review.check.md', type: 'codeReview' },
  { file: 'completion.check.md', type: 'completion' },
];

// Matches the `**Changes Hash:** <hash>` header written by report templates
// and write-qa-report.js.
const CHANGES_HASH_RE = /\*\*Changes Hash:\*\*\s*([a-f0-9]{12}|no-changes)/;

function safeExec(cmd, cwd) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Compute the current changes hash — identical semantics to
 * check-setup.js generateChangesHash(). Returns null when git is unavailable
 * (callers must fail-safe, never treat as drift).
 * @param {string} [cwd] - Worktree to diff in (defaults to process.cwd())
 * @returns {string|null}
 */
function computeChangesHash(cwd) {
  let baseBranch;
  try {
    const config = require(path.join(__dirname, '..', '..', 'lib', 'config'));
    baseBranch = config.getBaseBranch(cwd ? { cwd } : undefined);
  } catch {
    baseBranch = 'main';
  }
  // Probe git availability first so "empty diff" is distinguishable from
  // "git failed" (safeExec collapses both to '').
  if (!safeExec('git rev-parse --git-dir', cwd)) return null;
  const diff = safeExec(`git diff ${baseBranch}...HEAD -w`, cwd);
  if (!diff) return 'no-changes';
  return crypto.createHash('sha256').update(diff).digest('hex').substring(0, 12);
}

/**
 * Current HEAD SHA, or null when unavailable.
 * @param {string} [cwd]
 * @returns {string|null}
 */
function computeHeadSha(cwd) {
  const sha = safeExec('git rev-parse HEAD', cwd);
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

/**
 * Extract the `**Changes Hash:**` header value from report content.
 * @param {string} content
 * @returns {string|null}
 */
function extractReportHash(content) {
  const match = String(content || '').match(CHANGES_HASH_RE);
  return match ? match[1] : null;
}

/**
 * Parse every required report in `reportFolder` against `changesHash`.
 * @param {string} reportFolder
 * @param {string|null} changesHash - Hash the reports should be anchored to
 * @returns {Array<{file:string,type:string,present:boolean,status:string,reportHash:string|null,hashMatch:boolean}>}
 */
function evaluateReports(reportFolder, changesHash) {
  return REQUIRED_REPORTS.map(({ file, type }) => {
    let content = null;
    try {
      content = fs.readFileSync(path.join(reportFolder, file), 'utf8');
    } catch {
      /* absent */
    }
    const present = Boolean(content && content.trim());
    const { status } = parseReportStatus(content, type);
    const reportHash = present ? extractReportHash(content) : null;
    const knownHash = changesHash && changesHash !== 'unknown' ? changesHash : null;
    return {
      file,
      type,
      present,
      status,
      reportHash,
      hashMatch: Boolean(present && reportHash && knownHash && reportHash === knownHash),
    };
  });
}

/**
 * Reports that must block an "complete" answer: present, parsed NEEDS_WORK,
 * and anchored to the current hash (a report without a hash header, or when
 * the current hash is unknown, is conservatively treated as current — only a
 * report provably from a DIFFERENT hash is excluded, since the cycle purge
 * will remove it on the next run).
 * @param {ReturnType<typeof evaluateReports>} reports
 * @returns {ReturnType<typeof evaluateReports>}
 */
function blockingReports(reports) {
  return reports.filter(
    (r) => r.present && r.status === 'NEEDS_WORK' && (r.hashMatch || !r.reportHash)
  );
}

// Test/caller injection: an explicitly-provided probe wins over computing.
function resolveProbe(probeValue, computeFn, cwd) {
  return probeValue !== undefined ? probeValue : computeFn(cwd);
}

// SHA drift — fail-safe: only declare drift when BOTH sides are known.
function driftReasons(state, recordedHash, currentHash, currentHead) {
  const reasons = [];
  if (currentHash && recordedHash && recordedHash !== 'unknown' && currentHash !== recordedHash) {
    reasons.push(`sha-drift: changes hash ${recordedHash} → ${currentHash}`);
  }
  if (currentHead && state.completedHeadSha && currentHead !== state.completedHeadSha) {
    reasons.push(`sha-drift: HEAD ${state.completedHeadSha} → ${currentHead}`);
  }
  return reasons;
}

/**
 * Assess a terminal check state against the current working tree.
 *
 * @param {object} state - Parsed .check-state.json
 * @param {string} reportFolder - Folder containing *.check.md reports
 * @param {{currentHash?:string|null,currentHead?:string|null,cwd?:string}} [probes]
 *        Test/caller injection: pre-computed SHAs, or a cwd to compute them in.
 * @returns {{verdict:'stale'|'needs_work'|'valid', reasons:string[], reports:Array, currentHash:string|null, currentHead:string|null}}
 */
function assessTerminalState(state, reportFolder, probes = {}) {
  const currentHash = resolveProbe(probes.currentHash, computeChangesHash, probes.cwd);
  const currentHead = resolveProbe(probes.currentHead, computeHeadSha, probes.cwd);

  const recordedHash = state.completedChangesHash || state.changesHash || null;
  const reasons = driftReasons(state, recordedHash, currentHash, currentHead);

  const reports = evaluateReports(reportFolder, currentHash || recordedHash);

  if (reasons.length > 0) {
    return { verdict: 'stale', reasons, reports, currentHash, currentHead };
  }

  const blocking = blockingReports(reports);
  if (blocking.length > 0) {
    return {
      verdict: 'needs_work',
      reasons: blocking.map((r) => `${r.file} is NEEDS_WORK at the current changes hash`),
      reports,
      currentHash,
      currentHead,
    };
  }

  return { verdict: 'valid', reasons: [], reports, currentHash, currentHead };
}

/**
 * Record completion SHAs on the check state (GH-307 acceptance: store
 * completedHeadSha + completedChangesHash at the moment `complete` is set).
 * @param {object} state - Mutated in place
 * @param {{currentHead?:string|null,cwd?:string}} [probes]
 */
function recordCompletion(state, probes = {}) {
  state.completedChangesHash =
    state.changesHash && state.changesHash !== 'unknown' ? state.changesHash : null;
  state.completedHeadSha =
    probes.currentHead !== undefined ? probes.currentHead : computeHeadSha(probes.cwd);
  state.completedAt = new Date().toISOString();
}

module.exports = {
  REQUIRED_REPORTS,
  CHANGES_HASH_RE,
  computeChangesHash,
  computeHeadSha,
  extractReportHash,
  evaluateReports,
  blockingReports,
  assessTerminalState,
  recordCompletion,
};
