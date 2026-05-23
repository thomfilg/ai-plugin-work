'use strict';

/**
 * `eslint-bridge` — shells out to ESLint and folds four of the spec's six
 * quality dimensions into the shared violation shape:
 *
 *   complexity              → cyclomatic-complexity (max 10)
 *   max-depth               → max-depth (max 4)
 *   max-lines               → max-lines (max 400)
 *   max-lines-per-function  → max-lines-per-function (max 80)
 *
 * Config lives at `configs/quality-lint-rules.js` and is passed via
 * `--config` so the file name doesn't have to match ESLint's default-lookup
 * convention.
 *
 * Failure modes:
 *   - ESLint binary unresolvable          → throws (config error)
 *   - ESLint exits 2 (config/usage err)   → throws (config error)
 *   - stdout not valid JSON               → throws (config error)
 * Normal violations (ESLint exit 1) are parsed and returned.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveBin } = require('./_resolve-bin');

const CONFIG_PATH = path.join(__dirname, '..', 'configs', 'quality-lint-rules.js');

const RULE_MAP = {
  complexity: 'cyclomatic-complexity',
  'max-depth': 'max-depth',
  'max-lines': 'max-lines',
  'max-lines-per-function': 'max-lines-per-function',
};

const THRESHOLDS = {
  'cyclomatic-complexity': 10,
  'max-depth': 4,
  'max-lines': 400,
  'max-lines-per-function': 80,
};

function formatMessage(ruleId, raw) {
  const t = THRESHOLDS[ruleId];
  return t ? `${ruleId} > ${t} — ${raw}` : `${ruleId} — ${raw}`;
}

function runESLintCli(files, cwd) {
  let bin;
  try {
    bin = resolveBin('eslint', 'eslint');
  } catch (err) {
    throw new Error(`eslint-bridge: eslint binary not resolvable: ${err.message}`);
  }
  const args = [
    bin,
    '--no-config-lookup',
    '--config',
    CONFIG_PATH,
    '--format',
    'json',
    '--no-warn-ignored',
    ...files,
  ];
  const res = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // Treat any of these as a hard config error rather than parsing empty
  // stdout — silently returning [] would let the quality gate pass while
  // ESLint actually failed to run. `status === null` covers signal-kill /
  // OOM (matches the biome-bridge null-status guard).
  if (res.status === null || res.status === 2 || res.error) {
    const reason = res.error
      ? res.error.message
      : (res.stderr || `exited with status=${res.status}, signal=${res.signal}`).trim();
    throw new Error(`eslint-bridge: failed: ${reason}`);
  }
  return (res.stdout || '').trim();
}

function parseResults(stdout, repoRoot) {
  if (!stdout) return [];
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`eslint-bridge: malformed JSON from eslint: ${err.message}`);
  }
  const out = [];
  for (const fileResult of parsed) {
    const rel = path.relative(repoRoot, fileResult.filePath);
    for (const m of fileResult.messages || []) {
      const ruleId = m.ruleId && RULE_MAP[m.ruleId];
      if (!ruleId) continue;
      out.push({
        file: rel,
        line: m.line || 1,
        rule: ruleId,
        severity: 'error',
        message: formatMessage(ruleId, m.message),
      });
    }
  }
  return out;
}

function checkAll(absFiles, repoRoot) {
  if (!Array.isArray(absFiles) || absFiles.length === 0) return [];
  // Verify config exists; ESLint's error if missing is cryptic.
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`eslint-bridge: missing config at ${CONFIG_PATH}`);
  }
  const stdout = runESLintCli(absFiles, repoRoot);
  return parseResults(stdout, repoRoot);
}

module.exports = { checkAll, CONFIG_PATH, RULE_MAP, THRESHOLDS };
