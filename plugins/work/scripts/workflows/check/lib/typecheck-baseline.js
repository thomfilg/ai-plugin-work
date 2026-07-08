/**
 * typecheck-baseline.js — typecheck-error delta vs a per-ticket baseline for
 * the /check test runner (GH-394, echo-5137-issue-4).
 *
 * Answers "did MY changes regress typecheck?" instead of "is the whole repo
 * green?". Branches routinely inherit typecheck errors from the base branch
 * (sibling work); a plain `pnpm typecheck` run forces a manual
 * stash/checkout/diff dance to learn "those 8 aren't mine". This module
 * mirrors the tests-baseline machinery:
 *
 *   - the baseline (`typecheck-baseline.json`) lives in the ticket TASKS dir
 *     (same place `.check-state.json` and `tests-baseline.json` live —
 *     writing into the consumer repo pollutes worktrees; PR #669 review)
 *   - first classified run for the ticket captures the CURRENT error keys as
 *     the baseline (pragmatic: running typecheck at the merge-base would need
 *     a detached checkout, too invasive inline). The report ALWAYS states
 *     "N at baseline | M current | net new" so inherited errors are never
 *     silently blessed — they're listed as pre-existing, not as "clean".
 *   - refresh mirrors tests-baseline's green-run refresh: whenever a run has
 *     zero net-new errors the baseline is rewritten to the (equal-or-smaller)
 *     current set, so fixed errors ratchet the baseline down and can't be
 *     reintroduced for free.
 *
 * Toggle: CHECK_TYPECHECK_BASELINE=0 disables the whole delta (default on).
 * Command: SCRIPT_TYPECHECK_COMMAND (full-repo typecheck, e.g.
 * `pnpm exec tsc --noEmit`), validated through the safe-env-command
 * allowlist — unsafe values are treated as unconfigured, never executed.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { safeEnvCommand } = require('./safe-env-command');

const TYPECHECK_BASELINE_FILE = 'typecheck-baseline.json';
const TYPECHECK_TIMEOUT_MS = 300000;
// Stable-key message prefix length — long tsc messages embed type dumps that
// drift with unrelated edits; a fixed prefix keeps keys stable.
const MSG_PREFIX_LEN = 100;

// tsc error lines, both flavors:
//   src/a.ts(12,5): error TS2345: Argument of type ...   (classic)
//   src/a.ts:12:5 - error TS2345: Argument of type ...   (--pretty)
const TSC_ERROR_RE = /^(.*?)[(:](\d+)[,:](\d+)\)?(?::| -)\s*error\s+(TS\d+):\s+(.*)$/;

function typecheckBaselinePath(dir) {
  return path.join(dir || process.cwd(), TYPECHECK_BASELINE_FILE);
}

/**
 * Parse typecheck output into a sorted, de-duplicated set of STABLE error
 * keys: `file [TScode] message-prefix`.
 *
 * Line/column numbers are deliberately EXCLUDED from the key: an unrelated
 * edit higher in the file shifts every subsequent error's line number, which
 * would make each inherited error look "net new". The tradeoff is that two
 * genuinely distinct instances of the same error text in the same file
 * collapse into one key (a duplicated new instance of a pre-existing error
 * goes unflagged) — line-drift immunity is worth that rare miss.
 *
 * A nonzero exit with zero parseable error lines (non-tsc output, config
 * failure) yields one synthetic stable key so the failure still baselines
 * and deltas instead of being invisible.
 *
 * @param {string} output combined stdout+stderr
 * @param {number} exitCode
 * @returns {string[]} sorted unique keys
 */
function parseTypecheckErrors(output, exitCode) {
  const keys = new Set();
  for (const line of String(output || '').split('\n')) {
    const m = TSC_ERROR_RE.exec(line.trim());
    if (m) keys.add(`${m[1].trim()} [${m[4]}] ${m[5].trim().slice(0, MSG_PREFIX_LEN)}`);
  }
  if (keys.size === 0 && exitCode !== 0) {
    keys.add(`(unparseable typecheck failure — nonzero exit, no tsc error lines)`);
  }
  return [...keys].sort();
}

/**
 * Read the cached typecheck baseline. Returns null when
 * missing/unparseable/disabled (CHECK_TYPECHECK_BASELINE=0).
 * @param {string} [dir] ticket tasks dir (default cwd)
 * @returns {{ref: string|null, recordedAt: string, errors: string[]}|null}
 */
function readTypecheckBaseline(dir) {
  if (process.env.CHECK_TYPECHECK_BASELINE === '0') return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(typecheckBaselinePath(dir), 'utf8'));
    if (!parsed || !Array.isArray(parsed.errors)) return null;
    return {
      ref: typeof parsed.ref === 'string' ? parsed.ref : null,
      recordedAt: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : 'unknown',
      errors: parsed.errors.filter((e) => typeof e === 'string' && e.trim() !== ''),
    };
  } catch {
    return null;
  }
}

function currentGitRef() {
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    return execSync('git rev-parse HEAD', opts).trim();
  } catch {
    return null; // not a git repo
  }
}

/**
 * Record the current error-key set as the baseline. Best-effort — a write
 * failure never breaks the step.
 * @param {string} [dir] ticket tasks dir (default cwd)
 * @param {string[]} errors stable error keys
 */
function writeTypecheckBaseline(dir, errors) {
  if (process.env.CHECK_TYPECHECK_BASELINE === '0') return;
  const payload = { ref: currentGitRef(), recordedAt: new Date().toISOString(), errors };
  try {
    fs.writeFileSync(typecheckBaselinePath(dir), `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    /* best-effort */
  }
}

/**
 * Resolve the configured typecheck command. Returns null (feature silently
 * skipped) when unconfigured, disabled, or the value fails the allowlist —
 * an unsafe env value is NEVER executed (CodeQL hardening: no shell-string
 * interpolation of unvalidated env values).
 * @returns {string|null}
 */
function resolveTypecheckCommand() {
  if (process.env.CHECK_TYPECHECK_BASELINE === '0') return null;
  return safeEnvCommand(process.env.SCRIPT_TYPECHECK_COMMAND);
}

/**
 * Exact set split — keys are already canonical (no line numbers), so unlike
 * tests-baseline's loose containment matching, exact membership is correct.
 */
function splitTypecheckKeys(currentKeys, baselineKeys) {
  const base = new Set(baselineKeys);
  const netNew = [];
  const preExisting = [];
  for (const k of currentKeys) (base.has(k) ? preExisting : netNew).push(k);
  return { netNew, preExisting };
}

/**
 * Run the typecheck delta for the ticket. Returns null when the feature is
 * unconfigured/disabled (zero noise, zero cost); otherwise an assessment.
 *
 * @param {string} dir ticket tasks dir (baseline location)
 * @param {(cmd: string, timeout: number) => {output: string, exitCode: number}} run
 *        hardened single-command runner (injected: steps/run-tests.runCommand)
 * @returns {{cmd: string, firstRun: boolean, baselineCount: number,
 *            currentCount: number, netNew: string[], preExisting: string[]}|null}
 */
function assessTypecheck(dir, run) {
  const cmd = resolveTypecheckCommand();
  if (!cmd) return null;
  const result = run(cmd, TYPECHECK_TIMEOUT_MS);
  const current = parseTypecheckErrors(result.output, result.exitCode);
  const baseline = readTypecheckBaseline(dir);
  if (!baseline) {
    // First observed run for the ticket: capture, report everything as
    // pre-existing-at-baseline, flag nothing (see header comment for why).
    writeTypecheckBaseline(dir, current);
    return {
      cmd,
      firstRun: true,
      baselineCount: current.length,
      currentCount: current.length,
      netNew: [],
      preExisting: current.slice(),
    };
  }
  const { netNew, preExisting } = splitTypecheckKeys(current, baseline.errors);
  // Ratchet-down refresh: netNew === 0 implies current ⊆ baseline.
  if (netNew.length === 0) writeTypecheckBaseline(dir, current);
  return {
    cmd,
    firstRun: false,
    baselineCount: baseline.errors.length,
    currentCount: current.length,
    netNew,
    preExisting,
  };
}

/**
 * Report section lines for tests.check.md. Empty array when the feature is
 * skipped (assessment null) so callers can push unconditionally.
 */
function typecheckSection(a) {
  if (!a) return [];
  const lines = [
    '## Typecheck Delta',
    '',
    `**Command:** \`${a.cmd}\``,
    `**Errors at baseline:** ${a.baselineCount} | **errors now:** ${a.currentCount} | **net new from your changes:** ${a.netNew.length}`,
    '',
  ];
  if (a.firstRun) {
    lines.push(
      `Baseline captured on this run — ${a.currentCount} current error(s) recorded as pre-existing (likely inherited from the base branch); future runs flag only net-new keys.`,
      ''
    );
  }
  if (a.netNew.length > 0) {
    lines.push(`### Net-new typecheck errors (${a.netNew.length})`);
    lines.push(...a.netNew.map((k) => `- ${k}`), '');
  } else if (a.preExisting.length > 0 && !a.firstRun) {
    lines.push(`${a.preExisting.length} pre-existing error(s) (not yours) — not blocking.`, '');
  }
  return lines;
}

/**
 * Blocking reason for a typecheck regression (net-new > 0) when the test run
 * itself was green.
 */
function typecheckFailureReason(a) {
  const list = a.netNew.map((k) => `"${k}"`).join('; ');
  return `Typecheck regressed: ${a.netNew.length} net-new error(s) vs baseline (${a.preExisting.length} pre-existing, not yours). Net-new: ${list}. Needs fix in implement step.`;
}

module.exports = {
  TYPECHECK_BASELINE_FILE,
  typecheckBaselinePath,
  parseTypecheckErrors,
  readTypecheckBaseline,
  writeTypecheckBaseline,
  resolveTypecheckCommand,
  splitTypecheckKeys,
  assessTypecheck,
  typecheckSection,
  typecheckFailureReason,
};
