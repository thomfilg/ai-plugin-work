/**
 * report-head-staleness.js — GH-308 HEAD-staleness helpers for phase-1 reports.
 *
 * Phase-1 agents run in parallel; one agent's mid-run fix commit makes a
 * sibling's findings describe pre-fix code. Each report therefore carries a
 * canonical `**Head:** <sha>` line (the worktree HEAD the agent verified
 * against). These helpers resolve the live worktree HEAD, decide whether a
 * FAILING report is stale relative to it, and annotate a cap-exhausted stale
 * report that is accepted as-is. Extracted from steps/phase1-agents.js
 * (file-size budget) — all behavior unchanged.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Canonical `**Head:** <sha>` line each phase-1 report must carry (GH-308).
const HEAD_LINE_RE = /\*\*Head:\*\*\s*([0-9a-f]{7,40})\b/i;

/**
 * Current HEAD sha of the TICKET worktree (not the plugin checkout), or null
 * when unresolvable — callers fail-open (staleness checks are skipped).
 * `ctx.resolveHeadSha` is an injectable seam (tests / future probes), same
 * spirit as check-next.js `probes`.
 */
function currentWorktreeHead(state, ctx) {
  try {
    if (ctx && typeof ctx.resolveHeadSha === 'function') return ctx.resolveHeadSha() || null;
    const { resolveTicketWorktree } = require(
      path.join(__dirname, '..', '..', 'lib', 'resolve-ticket-worktree')
    );
    const worktree = resolveTicketWorktree(state.ticketId);
    if (!worktree) return null;
    return require('./staleness').computeHeadSha(worktree);
  } catch {
    return null;
  }
}

// SHA equality tolerant of short vs full form (min 7 chars enforced by regex).
function shaMatches(a, b) {
  if (!a || !b) return false; // '' startsWith '' is true — never match on empty
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * True when a present report is STALE per GH-308: it carries a Head line that
 * no longer matches the current worktree HEAD AND its verdict is failing.
 * Missing Head line, unknown current HEAD, or a passing verdict → not stale.
 */
function reportIsStale(content, statusType, currentHead) {
  if (!currentHead) return false; // HEAD unresolvable — fail-open
  const headMatch = String(content || '').match(HEAD_LINE_RE);
  if (!headMatch) return false; // legacy report without Head line — treat as current
  if (shaMatches(headMatch[1], currentHead)) return false;
  let status;
  try {
    const { parseReportStatus } = require(
      path.join(__dirname, '..', '..', 'lib', 'parse-report-status')
    );
    status = parseReportStatus(content, statusType).status;
  } catch {
    return false; // parser unavailable — fail-open
  }
  // Only failing verdicts go stale; PASS is never invalidated by HEAD movement.
  return status === 'NEEDS_WORK';
}

// Accept a cap-exhausted stale report as-is, but make the staleness visible
// to phase-2/humans by appending a Workflow Note (fail-open on write errors).
function annotateStaleAccepted(reportPath, reportHead, currentHead, maxAttempts) {
  try {
    fs.appendFileSync(
      reportPath,
      [
        '',
        '',
        '## Workflow Note',
        '',
        `HEAD-staleness cap reached (GH-308): this failing report was verified at ` +
          `Head ${reportHead} but the worktree HEAD has since moved to ${currentHead} ` +
          `after ${maxAttempts} dispatch attempts. Its findings may already ` +
          `be fixed at the current HEAD — re-verify each cited file:line before acting.`,
        '',
      ].join('\n')
    );
  } catch {
    /* fail-open — acceptance must not depend on the annotation */
  }
}

module.exports = {
  HEAD_LINE_RE,
  currentWorktreeHead,
  shaMatches,
  reportIsStale,
  annotateStaleAccepted,
};
