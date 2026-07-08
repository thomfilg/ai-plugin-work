'use strict';

/**
 * fabrication-detector.js
 *
 * Pure-function detector for fabricated test evidence in PR bodies.
 *
 * Exports `detectFabrication(prBody, taskDir)` which returns
 *   { violations: [{ phrase, reason, suggestion }] }
 *
 * Rules:
 *  R11 — Flag stability claims ("10/10", "N/N stability|stable|runs",
 *        "stability run") when no stability artifact exists in taskDir.
 *  R12 — Flag PASS/FAIL rows under "## Test Results" whose Test column is
 *        not present as a literal substring in tests.check.md or
 *        completion.check.md.
 *  R13 — Rows with Status pending|not run|skipped|n/a|— are always allowed.
 *  R14 — fs read errors → treat artifact as absent (fail-open for reads,
 *        which produces violations for unsourced claims — the safer default).
 *
 * Only allowed `reason` values: 'stability-claim' | 'unsourced-test-row'.
 * CommonJS, zero runtime deps.
 */

const fs = require('node:fs');
const path = require('node:path');

const STABILITY_REGEXES = [
  /\b\d+\/\d+\s+(stability|stable|runs?)\b/gi,
  /\bstability\s+run\b/gi,
  // Bare "10/10" only matches when NOT followed by another `/` or digit, so
  // calendar dates like `10/10/2026` and longer ratios like `10/100` are not
  // misclassified as stability claims.
  /\b10\/10\b(?![/\d])/gi,
];

const STABILITY_ARTIFACT_PATTERNS = [/^stability.*\.log$/i, /^stability.*\.md$/i];

// Only explicit pending-like words count as "no verdict claimed". Empty cells
// or dash placeholders are NOT allowed — otherwise a row can leave Status
// blank and smuggle verdict language into Notes, bypassing the sourcing
// check. The agent prompt requires "pending" explicitly.
const ALLOWED_STATUSES = new Set(['pending', 'not run', 'skipped', 'n/a']);

const TEST_RESULTS_HEADING = /^##\s+Test Results\s*$/i;
const ANY_H2 = /^##\s+/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function safeReaddir(dirPath) {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

// Minimum non-whitespace bytes required for a stability artifact to count as
// real evidence. An empty or whitespace-only placeholder file must not
// suppress the violation — that would make the guard trivially bypassable by
// dropping `touch stability.log` in the task folder.
const STABILITY_ARTIFACT_MIN_BYTES = 16;

function hasStabilityArtifact(taskDir) {
  // Stability claims require a real stability*.log/.md artifact with
  // substantive content. We deliberately do NOT honor a tests.check.md
  // substring fallback: warnings or negations that incidentally mention a
  // phrase like "10/10" would otherwise clear the violation. The agent prompt
  // mandates the stability log if a stability claim is made.
  if (!taskDir) return false;
  const entries = safeReaddir(taskDir);
  for (const entry of entries) {
    if (!STABILITY_ARTIFACT_PATTERNS.some((re) => re.test(entry))) continue;
    const content = safeReadFile(path.join(taskDir, entry));
    if (content && content.trim().length >= STABILITY_ARTIFACT_MIN_BYTES) return true;
  }
  return false;
}

function checkStabilityClaims(prBody, taskDir) {
  // Collect all matches across the overlapping STABILITY_REGEXES, then dedup
  // by character range: if a new match's [start, end) overlaps any already-
  // accepted range, drop it. Prefer longer matches when ranges overlap so a
  // phrase like "10/10 stability run" yields one violation, not three.
  const candidates = [];
  for (const re of STABILITY_REGEXES) {
    for (const m of prBody.matchAll(re)) {
      candidates.push({ start: m.index, end: m.index + m[0].length, phrase: m[0] });
    }
  }
  candidates.sort((a, b) => b.end - b.start - (a.end - a.start));

  const accepted = [];
  const overlaps = (a, b) => a.start < b.end && b.start < a.end;
  for (const c of candidates) {
    if (accepted.some((a) => overlaps(a, c))) continue;
    accepted.push(c);
  }
  accepted.sort((a, b) => a.start - b.start);

  const violations = [];
  for (const c of accepted) {
    if (hasStabilityArtifact(taskDir)) continue;
    violations.push({
      phrase: c.phrase,
      reason: 'stability-claim',
      suggestion:
        'Remove the stability claim or attach a stability*.log/stability*.md artifact in the task folder.',
    });
  }
  return violations;
}

function parseTableRow(line) {
  const m = line.match(TABLE_ROW);
  if (!m) return null;
  const cells = m[1].split('|').map((c) => c.trim());
  if (cells.length < 2) return null;
  if (cells.every((c) => /^[-:\s]*$/.test(c))) return null;
  if (cells[0].toLowerCase() === 'test') return null;
  return { test: cells[0], status: cells[1], notes: cells[2] || '' };
}

function parseTestResultsRows(prBody) {
  const lines = prBody.split(/\r?\n/);
  const rows = [];
  let inSection = false;
  for (const line of lines) {
    if (TEST_RESULTS_HEADING.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && ANY_H2.test(line)) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    const row = parseTableRow(line);
    if (row) rows.push(row);
  }
  return rows;
}

// Verdict-like wording that, when found in the Notes column of an otherwise
// pending row, indicates the agent is smuggling a claim past the Status check.
const NOTES_VERDICT_REGEX =
  /\b(pass(?:ed|es|ing)?|fail(?:ed|s|ing)?|ok|okay|green|success(?:ful)?|verified|works?|confirmed)\b/i;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rowIsSourced(testName, taskDir) {
  if (!taskDir || !testName) return false;
  // Word-boundary match — a test name like "login" must appear as a whole
  // word, not buried inside "login-flow-broken" or a random URL fragment.
  // Pad with non-word-char alternatives so tokens that don't start/end on a
  // word char (e.g. `"modal opens"`) still match.
  const escaped = escapeRegExp(testName);
  const re = new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, 'i');
  const candidates = ['tests.check.md', 'completion.check.md'];
  for (const name of candidates) {
    const content = safeReadFile(path.join(taskDir, name));
    if (content && re.test(content)) return true;
  }
  return false;
}

function checkTestResultsRows(prBody, taskDir) {
  const violations = [];
  const rows = parseTestResultsRows(prBody);
  for (const row of rows) {
    const statusLower = row.status.toLowerCase();
    const statusAllowed = ALLOWED_STATUSES.has(statusLower);
    // If Status is pending-like but the Notes column smuggles a verdict
    // (e.g. "PASS in CI" or "works in prod"), treat the row as a claim that
    // still needs sourcing. Otherwise pending rows always pass.
    const notes = typeof row.notes === 'string' ? row.notes : '';
    const notesHasVerdict = notes.length > 0 && NOTES_VERDICT_REGEX.test(notes);
    if (statusAllowed && !notesHasVerdict) continue;
    if (rowIsSourced(row.test, taskDir)) continue;
    // Surface the offending content — the Notes verdict if that's what
    // tripped it, otherwise the Status verdict.
    const offending = statusAllowed ? notes : row.status;
    violations.push({
      phrase: `| ${row.test} | ${row.status} | ${notes} |`,
      reason: 'unsourced-test-row',
      suggestion: `Rewrite to "pending" — remove "${offending}" or source "${row.test}" in tests.check.md / completion.check.md before claiming a verdict.`,
    });
  }
  return violations;
}

function detectFabrication(prBody, taskDir) {
  const body = typeof prBody === 'string' ? prBody : '';
  const dir = typeof taskDir === 'string' ? taskDir : '';
  const violations = [...checkStabilityClaims(body, dir), ...checkTestResultsRows(body, dir)];
  return { violations };
}

module.exports = { detectFabrication };
