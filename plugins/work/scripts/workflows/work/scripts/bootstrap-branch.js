#!/usr/bin/env node
/**
 * bootstrap-branch.js
 *
 * Resolves the worktree branch name for the bootstrap skill.
 *
 * Precedence (Task 1 scope):
 *   1. If `--git-branch-name <value>` is provided AND the configured ticket
 *      provider is Linear (TICKET_PROVIDER=linear), the value is used
 *      verbatim — Linear's `gitBranchName` field is authoritative.
 *   2. Otherwise, fall back to `<BRANCH_PREFIX><ticket-id-lowercased>-<kebab-summary>`.
 *      BRANCH_PREFIX defaults to empty string for backward compatibility.
 *
 * CLI contract:
 *   --ticket-id <id>           (required)
 *   --summary <text>           (required unless --git-branch-name is provided
 *                               AND it is used verbatim via the Linear path)
 *   --git-branch-name <value>  (optional)
 *
 * Output: resolved branch name on stdout (no trailing diagnostics).
 * Exit 0 on success; exit 1 on validation failure or missing required arg.
 */

'use strict';

const getConfig = require('../../lib/get-config');
const { loadEnvrcFromDirs } = require('./bootstrap-custom-script');

function parseArgs(argv) {
  const out = { ticketId: null, summary: null, gitBranchName: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--ticket-id') {
      out.ticketId = next;
      i++;
    } else if (flag === '--summary') {
      out.summary = next;
      i++;
    } else if (flag === '--git-branch-name') {
      out.gitBranchName = next;
      i++;
    }
  }
  return out;
}

function kebab(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function resolveBranchName({ ticketId, summary, gitBranchName }) {
  const provider = (getConfig('TICKET_PROVIDER') || '').toLowerCase();
  // Precedence rule (R1): Linear gitBranchName wins verbatim.
  if (gitBranchName && provider === 'linear') {
    return gitBranchName;
  }
  // Fallback composition (R2, R7).
  const prefix = getConfig('BRANCH_PREFIX') || '';
  const idSegment = String(ticketId).toLowerCase();
  const summarySegment = kebab(summary || '');
  return `${prefix}${idSegment}-${summarySegment}`;
}

function fail(message) {
  process.stderr.write(`bootstrap-branch: ${message}\n`);
  process.exit(1);
}

// Conservative safety regex: blocks shell metacharacters (`;`, `|`, `&`,
// backticks, `$`, whitespace) and `..` traversal sequences. Applied
// unconditionally — even when BRANCH_NAME_REGEX is unset (Task 2 / AC 1.2.1(d)).
const SAFETY_REGEX = /^[A-Za-z0-9._\-/]+$/;

/**
 * Build a "did you mean to set BRANCH_PREFIX=…?" suggestion for the failure
 * message when the resolved name fails BRANCH_NAME_REGEX but prepending a
 * plausible prefix would make it pass.
 *
 * Candidates considered, in order:
 *   1. The configured BRANCH_PREFIX (if non-empty).
 *   2. Prefixes inferred from a `^(a|b|c)/...` regex head.
 *   3. A prefix inferred from a `^literal/...` regex head.
 */
function inferPrefixCandidates(regex) {
  const candidates = [];
  const groupHead = /^\^\(\?:?([A-Za-z0-9_|\\\-]+)\)\\?\//.exec(regex)
    || /^\^\(([A-Za-z0-9_|\\\-]+)\)\\?\//.exec(regex);
  if (groupHead) {
    for (const alt of groupHead[1].split('|')) {
      candidates.push(`${alt.replace(/\\/g, '')}/`);
    }
    return candidates;
  }
  const literalHead = /^\^([A-Za-z0-9_\-]+)\\?\//.exec(regex);
  if (literalHead) candidates.push(`${literalHead[1]}/`);
  return candidates;
}

function buildPrefixSuggestion({ name, userRegex, regex, prefix }) {
  const candidates = [];
  if (prefix) candidates.push(prefix);
  for (const cand of inferPrefixCandidates(regex)) {
    if (!candidates.includes(cand)) candidates.push(cand);
  }
  for (const cand of candidates) {
    try {
      if (userRegex.test(`${cand}${name}`)) {
        return ` (did you mean to set BRANCH_PREFIX=${cand}?)`;
      }
    } catch (_err) {
      // ignore — main error message still produced
    }
  }
  return '';
}

function validate(name, { regex, prefix, isLinearVerbatim }) {
  // 1. Unconditional safety regex (shell metachars / `..` / whitespace).
  if (!SAFETY_REGEX.test(name) || name.includes('..')) {
    fail(`resolved name '${name}' contains disallowed characters (shell metacharacters or '..')`);
  }
  // 2. Optional user-configured BRANCH_NAME_REGEX gate.
  if (regex) {
    let userRegex;
    try {
      userRegex = new RegExp(regex);
    } catch (err) {
      fail(`BRANCH_NAME_REGEX '${regex}' is not a valid regular expression: ${err.message}`);
      return;
    }
    let matches = false;
    try {
      matches = userRegex.test(name);
    } catch (err) {
      fail(`BRANCH_NAME_REGEX '${regex}' threw during test: ${err.message}`);
      return;
    }
    if (!matches) {
      // Skip the BRANCH_PREFIX suggestion when the name is Linear's verbatim
      // `gitBranchName` — changing BRANCH_PREFIX has no effect on that path,
      // so the hint would mislead operators per the regex-vs-Linear conflict
      // documented in SKILL.md.
      const suggestion = isLinearVerbatim
        ? ''
        : buildPrefixSuggestion({ name, userRegex, regex, prefix });
      fail(`resolved name '${name}' does not match BRANCH_NAME_REGEX ${regex}${suggestion}`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ticketId) {
    fail('missing required flag --ticket-id');
  }
  // Mirror bootstrap-custom-script: source .envrc when direnv is not active so
  // TICKET_PROVIDER / BRANCH_PREFIX / BRANCH_NAME_REGEX are honored under bare shells.
  loadEnvrcFromDirs([process.cwd(), require('path').dirname(process.cwd())]);
  // --summary is only required when there is no Linear verbatim path.
  const providerIsLinear = (getConfig('TICKET_PROVIDER') || '').toLowerCase() === 'linear';
  if (!args.summary && !(args.gitBranchName && providerIsLinear)) {
    fail('missing required flag --summary (required unless --git-branch-name is provided with TICKET_PROVIDER=linear)');
  }
  const name = resolveBranchName(args);
  const regex = getConfig('BRANCH_NAME_REGEX') || '';
  const prefix = getConfig('BRANCH_PREFIX') || '';
  const isLinearVerbatim = Boolean(args.gitBranchName) && providerIsLinear;
  validate(name, { regex, prefix, isLinearVerbatim });
  process.stdout.write(`${name}\n`);
  process.exit(0);
}

main();
