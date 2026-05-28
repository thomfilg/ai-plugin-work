'use strict';

/**
 * lint-blast-radius — Pass C scanner.
 *
 * Resolves the project's lint command from `package.json` `scripts.lint`
 * (rejecting shell metacharacters), runs it, and partitions ESLint-style
 * JSON violations by membership in any task's `Files in scope`. For
 * out-of-scope violations, emits a SPLIT-WARNING record naming
 * `file:line/rule` plus the three operator-resolution option strings.
 *
 * Falls back to static-parsing a cached `eslint-output.json` when no
 * `scripts.lint` exists, appending a `Searched: <path>` note.
 *
 * Fails open on subprocess errors (emits a `lint pre-check skipped:`
 * warning record; never throws).
 *
 * Pure module: no console.*, no process.exit. Pulls only Node built-ins.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Shell metacharacters that would allow command chaining / substitution
// inside a string passed to a shell. Matching any of these triggers a
// pre-check skip so we never exec attacker-influenced shell strings.
const SHELL_METACHAR_RE = /[;&|`$<>(){}\n\r]|&&|\|\|/;

// The three operator-resolution option strings (R3, AC5).
const OPTION_A = '(a) add a Task 0 to fix the pre-existing violation';
const OPTION_B = '(b) accept blast-radius takeover and own the fix in this ticket';
const OPTION_C = '(c) confirm with brief author that scope is intentional';
const OPTIONS_LINE = `${OPTION_A}; ${OPTION_B}; ${OPTION_C}`;

/**
 * Resolve a safe lint command from a parsed package.json.
 *
 * @param {object} pkg parsed package.json
 * @returns {string|null} the lint command string, or null if missing/unsafe
 */
function resolveLintCommand(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object') return null;
  const lint = scripts.lint;
  if (typeof lint !== 'string' || lint.trim() === '') return null;
  if (SHELL_METACHAR_RE.test(lint)) return null;
  return lint;
}

/**
 * Read and parse `package.json` from a project root. Returns null on any
 * error (missing file, parse failure, etc.) — callers fall back to the
 * static-parse path.
 *
 * @param {string} projectRoot
 * @returns {object|null}
 */
function readPackageJson(projectRoot) {
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

/**
 * Parse an ESLint JSON report (array of file-result objects) into a flat
 * list of `{ file, line, ruleId }` entries.
 *
 * @param {unknown} report
 * @returns {Array<{file:string, line:number, ruleId:string}>}
 */
function flattenEslintReport(report) {
  if (!Array.isArray(report)) return [];
  const out = [];
  for (const fileEntry of report) {
    if (!fileEntry || typeof fileEntry !== 'object') continue;
    const file = typeof fileEntry.filePath === 'string' ? fileEntry.filePath : '';
    const messages = Array.isArray(fileEntry.messages) ? fileEntry.messages : [];
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      out.push({
        file,
        line: typeof m.line === 'number' ? m.line : 0,
        ruleId: typeof m.ruleId === 'string' ? m.ruleId : '',
      });
    }
  }
  return out;
}

/**
 * Try the static-parse fallback: read `eslint-output.json` from project
 * root, return both the violations and the searched path so we can
 * include a `Searched:` note in the warning.
 *
 * @param {string} projectRoot
 * @returns {{violations:Array<object>, searchedPath:string}|null}
 */
function staticParseEslintOutput(projectRoot) {
  const searchedPath = path.join(projectRoot, 'eslint-output.json');
  try {
    const raw = fs.readFileSync(searchedPath, 'utf8');
    const parsed = JSON.parse(raw);
    return { violations: flattenEslintReport(parsed), searchedPath };
  } catch (_err) {
    return { violations: [], searchedPath };
  }
}

/**
 * Run a lint command in `projectRoot` and parse its stdout as ESLint JSON.
 * Fail-open: returns null on any failure (exception, non-zero with no
 * parseable JSON, etc.) so the caller can emit a skipped-warning instead.
 *
 * @param {string} lintCommand
 * @param {string} projectRoot
 * @returns {{violations:Array<object>}|null}
 */
function runLintCommand(lintCommand, projectRoot) {
  try {
    // The command was already validated to contain no shell metacharacters,
    // so a simple whitespace tokenisation is sufficient and avoids the
    // shell entirely.
    const tokens = lintCommand.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    const [cmd, ...args] = tokens;
    const result = spawnSync(cmd, args, {
      cwd: projectRoot,
      encoding: 'utf8',
      shell: false,
    });
    if (result.error) return null;
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    if (!stdout.trim()) return null;
    const parsed = JSON.parse(stdout);
    return { violations: flattenEslintReport(parsed) };
  } catch (_err) {
    return null;
  }
}

/**
 * Build a Pass C warning record for a single out-of-scope violation.
 *
 * @param {{file:string, line:number, ruleId:string}} v
 * @param {string|null} searchedPath when set, appends a `Searched: <path>` note
 * @returns {{kind:'C', file:string, message:string, hint:string}}
 */
function buildViolationWarning(v, searchedPath) {
  const fileLabel = path.basename(v.file || '');
  const searchedSuffix = searchedPath ? ` Searched: ${searchedPath}.` : '';
  const message = `pre-existing lint violation ${fileLabel}:${v.line} (${v.ruleId}) is outside any task scope.`;
  const hint = `Resolve via: ${OPTIONS_LINE}.${searchedSuffix}`;
  return { kind: 'C', file: fileLabel, message, hint };
}

/**
 * Decide whether a violation file falls inside any declared task scope.
 *
 * @param {string} violationFile
 * @param {Set<string>} filesInScope
 * @returns {boolean}
 */
function isInScope(violationFile, filesInScope) {
  if (!(filesInScope instanceof Set) || filesInScope.size === 0) return false;
  if (filesInScope.has(violationFile)) return true;
  const base = path.basename(violationFile || '');
  if (filesInScope.has(base)) return true;
  for (const scoped of filesInScope) {
    if (typeof scoped !== 'string') continue;
    if (path.basename(scoped) === base) return true;
  }
  return false;
}

/**
 * Pass C entry point.
 *
 * @param {{projectRoot:string, lintCommand:string|null, filesInScope:Set<string>}} opts
 * @returns {{warnings:Array<object>}}
 */
function scan(opts) {
  const { projectRoot } = opts || {};
  const filesInScope = (opts && opts.filesInScope) || new Set();
  const warnings = [];

  if (typeof projectRoot !== 'string' || projectRoot === '') {
    warnings.push({
      kind: 'C',
      file: '',
      message: 'lint pre-check skipped: no projectRoot supplied.',
      hint: '',
    });
    return { warnings };
  }

  // Resolve the command: caller-supplied overrides package.json. An
  // explicit null/undefined means "use static-parse fallback".
  let effectiveCommand = null;
  let commandSource = 'caller';
  if (opts && opts.lintCommand !== undefined && opts.lintCommand !== null) {
    if (typeof opts.lintCommand === 'string' && !SHELL_METACHAR_RE.test(opts.lintCommand)) {
      effectiveCommand = opts.lintCommand;
    } else if (typeof opts.lintCommand === 'string') {
      // Unsafe caller-supplied string: refuse to execute.
      warnings.push({
        kind: 'C',
        file: '',
        message: 'lint pre-check skipped: lintCommand contains shell metacharacters; refusing to execute.',
        hint: `Resolve via: ${OPTIONS_LINE}.`,
      });
      return { warnings };
    }
  } else {
    const pkg = readPackageJson(projectRoot);
    effectiveCommand = resolveLintCommand(pkg);
    commandSource = 'package.json';
  }

  let violations = [];
  let searchedPath = null;

  if (effectiveCommand) {
    const ran = runLintCommand(effectiveCommand, projectRoot);
    if (!ran) {
      warnings.push({
        kind: 'C',
        file: '',
        message: `lint pre-check skipped: command failed or produced no parseable JSON (source: ${commandSource}).`,
        hint: `Resolve via: ${OPTIONS_LINE}.`,
      });
      return { warnings };
    }
    violations = ran.violations;
  } else {
    // Static-parse fallback: no `lint` script in package.json.
    const fallback = staticParseEslintOutput(projectRoot);
    violations = fallback.violations;
    searchedPath = fallback.searchedPath;
  }

  for (const v of violations) {
    if (isInScope(v.file, filesInScope)) continue;
    warnings.push(buildViolationWarning(v, searchedPath));
  }

  return { warnings };
}

module.exports = {
  resolveLintCommand,
  scan,
  SHELL_METACHAR_RE,
  OPTIONS_LINE,
};
