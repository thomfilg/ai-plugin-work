/**
 * monitor-status-line.js — pure formatters for the monitor step's output.
 *
 * Extracted from monitor.js (file-size budget). `buildOutput` produces the
 * full report text (delegating to follow-up-pr.js's formatReport, with a
 * fallback), and `buildStatusLine` builds the compact one-line stderr summary.
 * All functions here are pure — no shell-outs, no state mutation.
 */

'use strict';

function buildOutput(state, prInfo, ci, reviews, formatReport) {
  const attempt = state.attempt || 1;
  const maxAttempts = state.maxAttempts || 40;
  try {
    return formatReport(prInfo, ci, reviews, attempt, maxAttempts, {});
  } catch {
    const lines = [
      `PR: #${prInfo.number} — ${prInfo.title || ''}`,
      `CI: ${ci.status || 'unknown'}`,
    ];
    if (reviews.hasBlocking) lines.push(`Reviews: ${reviews.blocking.length} BLOCKING`);
    else if (reviews.pendingBots && reviews.pendingBots.length > 0)
      lines.push('Reviews: Awaiting bot reviews');
    else lines.push('Reviews: CLEAR');
    return lines.join('\n');
  }
}

function formatElapsed(monitorStartTime) {
  if (!monitorStartTime) return '';
  const ms = Date.now() - new Date(monitorStartTime).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
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

function buildStatusLine(state, ci, reviews) {
  const attempt = state.attempt || 1;
  const maxAttempts = state.maxAttempts || 40;
  const parts = ciCountParts(ci, reviews);
  const statusLabel = ciStatusLabel(ci.status);
  const detail = ciDetail(ci);
  const elapsed = formatElapsed(state._monitorStartTime);
  const counts = parts.length > 0 ? parts.join(' ╎ ') : '';
  const poll = `${attempt}/${maxAttempts}`;
  const line1 = [statusLabel, poll, elapsed, counts].filter(Boolean).join(' · ');
  return { line1, detail };
}

module.exports = { buildOutput, buildStatusLine };
