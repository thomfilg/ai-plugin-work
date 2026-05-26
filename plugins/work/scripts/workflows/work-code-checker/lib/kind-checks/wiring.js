/**
 * Kind: wiring — code-quality check for "connect-existing-pieces" tickets.
 *
 * Wiring code should be small and additive. Flag:
 *  - Any file > 300 lines added in the diff (suspicious for wiring).
 *  - Any `// TODO` left in changed files.
 *  - TS safety violations.
 */

'use strict';

const {
  readBrief,
  readChangedFiles,
  readFileFromWorktree,
  scanTypeScriptViolations,
  isBackendFile,
  briefForbidsBackend,
  detectKinds,
} = require('./shared');

function appliesTo(ctx) {
  const kinds = detectKinds(ctx.tasksDir);
  if (kinds.includes('wiring')) return true;
  const brief = readBrief(ctx.tasksDir);
  if (briefForbidsBackend(brief) && kinds.length === 0) return true;
  return false;
}

function validate(ctx) {
  const brief = readBrief(ctx.tasksDir);
  const changed = readChangedFiles(ctx);
  const errors = [];
  const warnings = [];

  const tsHits = scanTypeScriptViolations(ctx, changed);
  if (tsHits.length) {
    errors.push(
      `Wiring code introduced TypeScript safety violations (${tsHits.length}): ${tsHits
        .slice(0, 3)
        .map((h) => `${h.file}:${h.line} (${h.pattern})`)
        .join('; ')}${tsHits.length > 3 ? '; …' : ''}.`
    );
  }

  if (briefForbidsBackend(brief)) {
    const drift = changed.filter(isBackendFile);
    if (drift.length) {
      errors.push(
        `Wiring + brief forbids backend changes, but diff contains backend files: ${drift
          .map((f) => `\`${f}\``)
          .join(', ')}. ECHO-4579 failure mode.`
      );
    }
  }

  const largeFiles = [];
  const todoOffenders = [];
  for (const f of changed) {
    if (!/\.(ts|tsx|js|jsx)$/.test(f)) continue;
    const text = readFileFromWorktree(ctx, f);
    if (!text) continue;
    const lineCount = text.split('\n').length;
    if (lineCount > 300) largeFiles.push({ f, lineCount });
    if (/\/\/\s*TODO\b/.test(text)) todoOffenders.push(f);
  }
  if (largeFiles.length) {
    warnings.push(
      `Wiring changes touch large files (>300 lines): ${largeFiles
        .map(({ f, lineCount }) => `\`${f}\` (${lineCount}L)`)
        .join(', ')}. Verify the wiring is actually small.`
    );
  }
  if (todoOffenders.length) {
    warnings.push(
      `\`// TODO\` left in changed files: ${todoOffenders
        .slice(0, 3)
        .map((f) => `\`${f}\``)
        .join(', ')}${todoOffenders.length > 3 ? ', …' : ''}.`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${changed.length} files, ${tsHits.length} ts-violations, ${todoOffenders.length} TODOs`,
  };
}

module.exports = function register(registerKind) {
  registerKind('wiring', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
