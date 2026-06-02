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
  /\b10\/10\b/gi,
];

const STABILITY_ARTIFACT_PATTERNS = [/^stability.*\.log$/i, /^stability.*\.md$/i];

const ALLOWED_STATUSES = new Set(['pending', 'not run', 'skipped', 'n/a', '—', '-', '']);

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

function hasStabilityArtifact(taskDir, claimText) {
  if (!taskDir) return false;
  const entries = safeReaddir(taskDir);
  for (const entry of entries) {
    if (STABILITY_ARTIFACT_PATTERNS.some((re) => re.test(entry))) return true;
  }
  // tests.check.md containing the literal claim text also counts as evidence.
  const checks = safeReadFile(path.join(taskDir, 'tests.check.md'));
  if (checks && claimText && checks.includes(claimText)) return true;
  return false;
}

function checkStabilityClaims(prBody, taskDir) {
  const violations = [];
  const seen = new Set();
  for (const re of STABILITY_REGEXES) {
    for (const match of prBody.matchAll(re)) {
      const phrase = match[0];
      const key = `${match.index}:${phrase}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (hasStabilityArtifact(taskDir, phrase)) continue;
      violations.push({
        phrase,
        reason: 'stability-claim',
        suggestion:
          'Remove the stability claim or attach a stability*.log/stability*.md artifact in the task folder.',
      });
    }
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

function rowIsSourced(testName, taskDir) {
  if (!taskDir || !testName) return false;
  const candidates = ['tests.check.md', 'completion.check.md'];
  for (const name of candidates) {
    const content = safeReadFile(path.join(taskDir, name));
    if (content && content.includes(testName)) return true;
  }
  return false;
}

function checkTestResultsRows(prBody, taskDir) {
  const violations = [];
  const rows = parseTestResultsRows(prBody);
  for (const row of rows) {
    const statusLower = row.status.toLowerCase();
    if (ALLOWED_STATUSES.has(statusLower)) continue;
    if (statusLower !== 'pass' && statusLower !== 'fail') continue;
    if (rowIsSourced(row.test, taskDir)) continue;
    violations.push({
      phrase: `| ${row.test} | ${row.status} |`,
      reason: 'unsourced-test-row',
      suggestion: `Rewrite Status to "pending" until tests.check.md or completion.check.md contains "${row.test}".`,
    });
  }
  return violations;
}

function detectFabrication(prBody, taskDir) {
  const body = typeof prBody === 'string' ? prBody : '';
  const dir = typeof taskDir === 'string' ? taskDir : '';
  const violations = [
    ...checkStabilityClaims(body, dir),
    ...checkTestResultsRows(body, dir),
  ];
  return { violations };
}

module.exports = { detectFabrication };
