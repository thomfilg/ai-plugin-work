/**
 * monitor-status-line.js — pure formatters for the monitor step's output.
 *
 * Extracted from monitor.js (file-size budget). `buildOutput` produces the
 * full report text (delegating to follow-up-pr.js's formatReport, with a
 * fallback), and `buildStatusLine` builds the compact one-line stderr summary.
 * All functions here are pure — no shell-outs, no state mutation.
 */

'use strict';

const { formatDurationMs } = require('../../../lib/statusline/duration');

// GH-670: one line for demoted body-only COMMENTED reviews from
// non-allowlisted reviewers. Deliberately does NOT start with "Reviews:" so
// triage's /Reviews:.*BLOCKING/ signal can never match it.
function noticesLine(reviews) {
  const n = reviews && reviews.notices ? reviews.notices.length : 0;
  if (n === 0) return '';
  return `Notices: ${n} notice(s) — comment-only review(s) from non-allowlisted reviewer(s); cannot block merge, no action required`;
}

// One-line reviews summary for the fallback report (formatReport threw).
function reviewsSummaryLine(reviews) {
  if (reviews.hasBlocking) return `Reviews: ${reviews.blocking.length} BLOCKING`;
  if (reviews.pendingBots && reviews.pendingBots.length > 0) return 'Reviews: Awaiting bot reviews';
  return 'Reviews: CLEAR';
}

// Minimal report used when formatReport throws.
function fallbackReport(prInfo, ci, reviews, notices) {
  const lines = [`PR: #${prInfo.number} — ${prInfo.title || ''}`, `CI: ${ci.status || 'unknown'}`];
  lines.push(reviewsSummaryLine(reviews));
  if (notices) lines.push(notices);
  return lines.join('\n');
}

function buildOutput(state, prInfo, ci, reviews, formatReport) {
  const attempt = state.attempt || 1;
  const maxAttempts = state.maxAttempts || 40;
  const notices = noticesLine(reviews);
  try {
    const report = formatReport(prInfo, ci, reviews, attempt, maxAttempts, {});
    return notices ? `${report}\n${notices}` : report;
  } catch {
    return fallbackReport(prInfo, ci, reviews, notices);
  }
}

function formatElapsed(monitorStartTime) {
  if (!monitorStartTime) return '';
  return formatDurationMs(Date.now() - new Date(monitorStartTime).getTime());
}

function pushCount(parts, emoji, list) {
  if (list && list.length > 0) parts.push(`${emoji} ${list.length}`);
}

function ciCountParts(ci, reviews) {
  const parts = [];
  pushCount(parts, '🔄', ci.running);
  pushCount(parts, '✅', ci.passed);
  pushCount(parts, '🔴', ci.failed);
  pushCount(parts, '⊘', ci.cancelled);
  pushCount(parts, '🤖', reviews.pendingBots);
  if (reviews.hasBlocking) parts.push(`💬 ${reviews.blocking.length}`);
  // GH-670: non-blocking notices (demoted COMMENTED reviews) — separate count.
  pushCount(parts, '🔔', reviews.notices);
  return parts;
}

function ciStatusLabel(status) {
  if (status === 'passing') return '✓ CI';
  if (status === 'failing') return '✗ CI';
  if (status === 'pending') return '⏳ CI';
  return `CI:${status || '?'}`;
}

function ciDetail(ci) {
  if (ci.failed && ci.failed.length > 0) return `✗ ${ci.failed[0].name} — failed`;
  if (ci.running && ci.running.length > 0) return `⏳ ${ci.running[0].name} — running`;
  if (ci.passed && ci.passed.length > 0)
    return `✓ ${ci.passed[ci.passed.length - 1].name} — passed`;
  return '';
}

// Compose the one-line summary from structured parts + a (re)computed
// elapsed string. Shared by the monitor step (persist time) and the status
// bar renderer (refresh time) so the timer ticks live instead of freezing at
// whatever the last monitor cycle stringified.
function composeStatusLine(parts, elapsed) {
  return [parts.statusLabel, parts.poll, elapsed, parts.counts].filter(Boolean).join(' · ');
}

function buildStatusLine(state, ci, reviews) {
  const attempt = state.attempt || 1;
  const maxAttempts = state.maxAttempts || 40;
  const countParts = ciCountParts(ci, reviews);
  const detail = ciDetail(ci);
  const parts = {
    statusLabel: ciStatusLabel(ci.status),
    poll: `${attempt}/${maxAttempts}`,
    counts: countParts.length > 0 ? countParts.join(' ╎ ') : '',
  };
  const line1 = composeStatusLine(parts, formatElapsed(state._monitorStartTime));
  return { line1, detail, parts };
}

module.exports = { buildOutput, buildStatusLine, composeStatusLine, formatElapsed };
