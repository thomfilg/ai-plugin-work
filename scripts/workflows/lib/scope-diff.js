/**
 * scope-diff.js
 *
 * Gate E — pure helper that compares a git diff file list against the union
 * of every task's `### Files in scope` declarations. Used by the check step
 * and the completion-checker agent to surface out-of-scope changes BEFORE
 * the PR is opened.
 *
 * Inputs are pure data:
 *   - `diffFiles`: string[] (output of `git diff --name-only origin/main...HEAD`)
 *   - `tasks`:     Array<{filesInScope?: string[], filesOutOfScope?: string[],
 *                          suggestedScope?: string}> (from task-parser.parseTasks)
 *
 * Output:
 *   {
 *     inScope:        string[],  // files matched by at least one task's filesInScope
 *     outOfScope:     string[],  // files matched by ANY task's filesOutOfScope
 *     unaccounted:    string[],  // files matched by neither
 *     totals:         {inScope, outOfScope, unaccounted, total}
 *   }
 */

'use strict';

const { globToRegex } = require('./hooks/policies/scope-protection');

function _parseLegacySuggestedScope(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/^[-*+]\s+/, '')
        .replace(/^`+|`+$/g, '')
        .trim()
    )
    .filter((l) => l && !l.startsWith('<!--'));
}

function _scopeForTask(task) {
  if (Array.isArray(task.filesInScope) && task.filesInScope.length > 0) {
    return task.filesInScope;
  }
  // Legacy fallback so tasks written before Gate C still inform Gate E.
  return _parseLegacySuggestedScope(task.suggestedScope);
}

function _compileMany(patterns) {
  const out = [];
  for (const p of patterns) {
    if (!p || typeof p !== 'string') continue;
    try {
      out.push(globToRegex(p));
    } catch {
      /* skip */
    }
  }
  return out;
}

function _matchesAny(filePath, regexes) {
  for (const re of regexes) {
    if (re.test(filePath)) return true;
  }
  return false;
}

/**
 * @param {string[]} diffFiles - File paths from git diff, posix-style
 * @param {Array<object>} tasks - Tasks from task-parser
 * @returns {{inScope:string[], outOfScope:string[], unaccounted:string[], totals:object}}
 */
function compareDiffToScope(diffFiles, tasks) {
  if (!Array.isArray(diffFiles)) {
    return {
      inScope: [],
      outOfScope: [],
      unaccounted: [],
      totals: { inScope: 0, outOfScope: 0, unaccounted: 0, total: 0 },
    };
  }
  const taskList = Array.isArray(tasks) ? tasks : [];

  // Compile union of in-scope and out-of-scope patterns
  const inPatterns = [];
  const outPatterns = [];
  for (const t of taskList) {
    inPatterns.push(..._scopeForTask(t));
    if (Array.isArray(t.filesOutOfScope)) outPatterns.push(...t.filesOutOfScope);
  }
  const inRegex = _compileMany(inPatterns);
  const outRegex = _compileMany(outPatterns);

  const inScope = [];
  const outOfScope = [];
  const unaccounted = [];

  for (const raw of diffFiles) {
    if (typeof raw !== 'string' || !raw) continue;
    const file = raw.replace(/\\/g, '/');
    if (_matchesAny(file, outRegex)) {
      outOfScope.push(file);
      continue;
    }
    if (_matchesAny(file, inRegex)) {
      inScope.push(file);
      continue;
    }
    unaccounted.push(file);
  }

  return {
    inScope,
    outOfScope,
    unaccounted,
    totals: {
      inScope: inScope.length,
      outOfScope: outOfScope.length,
      unaccounted: unaccounted.length,
      total: inScope.length + outOfScope.length + unaccounted.length,
    },
  };
}

/**
 * Render a human-readable summary of the diff comparison. Used by the
 * check step enrichment to inject into the completion-checker prompt and
 * by the PR generator when writing the "Out-of-scope changes" section.
 *
 * @param {ReturnType<typeof compareDiffToScope>} result
 * @returns {string}
 */
function summarizeScopeDiff(result) {
  if (!result) return '';
  const lines = [];
  lines.push('## Scope-diff summary');
  lines.push(`- in scope:        ${result.totals.inScope}`);
  lines.push(`- out of scope:    ${result.totals.outOfScope}  (sibling-owned)`);
  lines.push(`- unaccounted:     ${result.totals.unaccounted}  (no task declared this file)`);
  lines.push('');
  if (result.outOfScope.length > 0) {
    lines.push('### Sibling-owned files in diff (BLOCKING)');
    for (const f of result.outOfScope) lines.push(`- ${f}`);
    lines.push('');
  }
  if (result.unaccounted.length > 0) {
    lines.push('### Unaccounted files in diff (needs justification)');
    for (const f of result.unaccounted) lines.push(`- ${f}`);
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { compareDiffToScope, summarizeScopeDiff };
