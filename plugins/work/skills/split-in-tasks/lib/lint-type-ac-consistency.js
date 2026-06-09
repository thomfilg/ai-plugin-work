'use strict';

const {
  isKnownTaskType,
  scopeRulesFor,
  matchesTypeScope,
  isTestFilePath,
} = require('./task-types');

const DOCS_EXEMPTION_PATTERNS = Object.freeze([
  /documentation[\s-]*exempt/i,
  /docs[-\s]?only/i,
  /no\s+RED[\/\s]GREEN(?:[\/\s]REFACTOR)?\s+(?:cycle\s+)?required/i,
  /documentation\/manifest only/i,
  /config[-\s]?only/i,
  /manifest[-\s]?only/i,
  /no\s+test(?:able)?\s+surface/i,
]);

// "new behavior" markers that should not appear in a tests-only / docs /
// mechanical-refactor / file-move AC. These tasks describe existing-behavior
// coverage or pure transforms, not new feature work.
const NEW_BEHAVIOR_PATTERNS = Object.freeze([
  /\bimplement\b/i,
  /\badd\s+(?:a\s+)?(?:new\s+)?(?:feature|endpoint|api|capability)\b/i,
  /\bfix\s+(?:a\s+)?bug\b/i,
  /\bnew\s+behavior\b/i,
  /\bintroduce\s+(?:a\s+)?(?:new\s+)?\w+/i,
]);

function parseTaskType(section) {
  if (typeof section !== 'string') return null;
  const lines = section.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (/^###\s+Type\s*$/i.test(lines[i].trim())) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j].trim();
        if (!next) continue;
        if (next.startsWith('#')) break;
        return next.toLowerCase();
      }
    }
  }
  return null;
}

function parseFilesInScope(section) {
  if (typeof section !== 'string') return [];
  const lines = section.split(/\r?\n/);
  const out = [];
  let inScope = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (/^###\s+Files in scope\b/i.test(trimmed)) {
      inScope = true;
      continue;
    }
    if (!inScope) continue;
    if (/^###\s+/.test(trimmed) || /^##\s+/.test(trimmed)) break;
    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    if (!bullet) continue;
    const cleaned = bullet[1].replace(/`/g, '').trim();
    // Drop trailing comments " # owned by …".
    const withoutComment = cleaned.replace(/\s+#.*$/, '').trim();
    if (withoutComment) out.push(withoutComment);
  }
  return out;
}

function findOffendingAcLine(acLines) {
  if (!Array.isArray(acLines)) return null;
  for (const line of acLines) {
    if (typeof line !== 'string') continue;
    for (const pattern of DOCS_EXEMPTION_PATTERNS) {
      if (pattern.test(line)) return line;
    }
  }
  return null;
}

function findNewBehaviorLine(acLines) {
  if (!Array.isArray(acLines)) return null;
  for (const line of acLines) {
    if (typeof line !== 'string') continue;
    for (const pattern of NEW_BEHAVIOR_PATTERNS) {
      if (pattern.test(line)) return line;
    }
  }
  return null;
}

function makeWarning({ file, taskNumber, message, hint }) {
  return { kind: 'D', file, message: `Task ${taskNumber}: ${message}`, hint };
}

// ── Per-Type checks ─────────────────────────────────────────────────────────

function checkDocsExemptionTypeMismatch({ file, taskNumber, section, acceptanceCriteria }) {
  const acLine = findOffendingAcLine(acceptanceCriteria);
  if (!acLine) return null;
  const declaredType = parseTaskType(section);
  if (declaredType === 'docs') return null;
  return {
    kind: 'D',
    file,
    message:
      `Task ${taskNumber}: Acceptance Criteria "${acLine}" declares ` +
      `docs-exemption but Type is "${declaredType || 'unknown'}".`,
    hint: 'propose Type: docs',
  };
}

function checkTddCodeContract({ file, taskNumber, type, filesInScope, acceptanceCriteria }) {
  if (type !== 'tdd-code') return [];
  const warnings = [];
  const hasTest = filesInScope.some(isTestFilePath);
  const hasSource = filesInScope.some((p) => p && !isTestFilePath(p));
  if (!hasTest) {
    warnings.push(
      makeWarning({
        file,
        taskNumber,
        message: 'Type=tdd-code but `### Files in scope` lists no `*.test.*` / `*.spec.*` file.',
        hint: 'add the failing-test file to scope, or change Type to tests-only/docs/config/ci',
      })
    );
  }
  if (!hasSource) {
    warnings.push(
      makeWarning({
        file,
        taskNumber,
        message: 'Type=tdd-code but `### Files in scope` lists no non-test source file.',
        hint: 'add the implementation file to scope, or change Type to tests-only',
      })
    );
  }
  if (findOffendingAcLine(acceptanceCriteria)) {
    // Already handled by checkDocsExemptionTypeMismatch — skip duplicate.
  }
  return warnings;
}

function checkTestsOnlyContract({ file, taskNumber, type, filesInScope, acceptanceCriteria }) {
  if (type !== 'tests-only') return [];
  const warnings = [];
  if (filesInScope.length === 0) {
    warnings.push(
      makeWarning({
        file,
        taskNumber,
        message: 'Type=tests-only but `### Files in scope` is empty.',
        hint: 'list at least one `*.test.*` / `*.spec.*` file in scope',
      })
    );
  } else {
    const nonTest = filesInScope.filter((p) => !isTestFilePath(p));
    if (nonTest.length > 0) {
      warnings.push(
        makeWarning({
          file,
          taskNumber,
          message: `Type=tests-only but scope includes non-test file(s): ${nonTest.join(', ')}.`,
          hint: 'move source edits to a tdd-code task, or change Type to tdd-code',
        })
      );
    }
  }
  const newBehavior = findNewBehaviorLine(acceptanceCriteria);
  if (newBehavior) {
    warnings.push(
      makeWarning({
        file,
        taskNumber,
        message:
          `Type=tests-only AC "${newBehavior}" describes new behavior — ` +
          'tests-only tasks cover EXISTING behavior.',
        hint: 'rewrite AC to describe coverage of existing behavior, or change Type to tdd-code',
      })
    );
  }
  return warnings;
}

function checkDocsContract({ file, taskNumber, type, filesInScope, acceptanceCriteria }) {
  if (type !== 'docs') return [];
  const warnings = [];
  if (filesInScope.length > 0) {
    const nonMd = filesInScope.filter((p) => !/\.md$/i.test(p));
    if (nonMd.length > 0) {
      warnings.push(
        makeWarning({
          file,
          taskNumber,
          message: `Type=docs but scope includes non-\`.md\` file(s): ${nonMd.join(', ')}.`,
          hint: 'move non-docs edits to a tdd-code/config/ci task, or split the task',
        })
      );
    }
  }
  const newBehavior = findNewBehaviorLine(acceptanceCriteria);
  if (newBehavior) {
    warnings.push(
      makeWarning({
        file,
        taskNumber,
        message:
          `Type=docs AC "${newBehavior}" promises behavior change — ` +
          'docs tasks must not ship behavior.',
        hint: 'rewrite AC to describe documentation only, or change Type',
      })
    );
  }
  return warnings;
}

function checkAllowlistedScope({ file, taskNumber, type, filesInScope }) {
  // For closed-allowlist types (config, ci), verify every scope entry matches.
  if (type !== 'config' && type !== 'ci') return [];
  const rules = scopeRulesFor(type);
  if (!rules || !rules.scopePatterns) return [];
  const offenders = filesInScope.filter((p) => !matchesTypeScope(type, p));
  if (offenders.length === 0) return [];
  return [
    makeWarning({
      file,
      taskNumber,
      message:
        `Type=${type} but scope includes file(s) outside the ${type} allowlist: ` +
        `${offenders.join(', ')}.`,
      hint:
        type === 'config'
          ? 'move runtime/behavior files to a tdd-code task, or extend task-types.js allowlist'
          : 'move non-CI files to the appropriate Type, or extend task-types.js allowlist',
    }),
  ];
}

function checkUnknownType({ file, taskNumber, type }) {
  if (!type) return null;
  if (isKnownTaskType(type)) return null;
  return makeWarning({
    file,
    taskNumber,
    message:
      `Type="${type}" is not in the closed taxonomy ` +
      '(tdd-code, tests-only, docs, config, ci, mechanical-refactor, file-move, checkpoint).',
    hint: 'pick a Type from plugins/work/skills/split-in-tasks/lib/task-types.js',
  });
}

/**
 * Validate Type/AC consistency across a parsed tasks.md model.
 *
 * Backward-compatible: returns the FIRST docs-exemption / Type mismatch
 * warning (legacy callers — Pass D aggregation used `for-each task` and
 * stopped at the first one). Use `lintAllPassD` for the multi-warning surface
 * Pass D needs.
 */
function lintTypeAcConsistency(taskModel) {
  const all = lintAllPassD(taskModel);
  if (all.length === 0) return null;
  // Prefer the legacy docs-exemption shape if present (hint === 'propose Type: docs')
  // so existing callers see the same record they used to.
  const legacy = all.find((w) => w.hint === 'propose Type: docs');
  return legacy || all[0];
}

/**
 * Run every kind-D check across a parsed tasks.md model and return ALL
 * warnings. Each task may contribute 0..N warnings.
 *
 * Input shape:
 *   { file: string, tasks: Array<{ number, section, acceptanceCriteria }> }
 *
 * Warning shape: { kind: 'D', file, message, hint }
 */
function buildTaskCtx(task, file) {
  const taskNumber = task.number;
  const section = task.section || '';
  const acceptanceCriteria = task.acceptanceCriteria || [];
  const type = parseTaskType(section) || '';
  const filesInScope =
    Array.isArray(task.filesInScope) && task.filesInScope.length > 0
      ? task.filesInScope
      : parseFilesInScope(section);
  return { file, taskNumber, type, section, filesInScope, acceptanceCriteria };
}

function lintOneTask(ctx) {
  const warnings = [];
  const { file, taskNumber, section, acceptanceCriteria, type } = ctx;
  const docsMismatch = checkDocsExemptionTypeMismatch({
    file,
    taskNumber,
    section,
    acceptanceCriteria,
  });
  if (docsMismatch) warnings.push(docsMismatch);
  const unknown = checkUnknownType({ file, taskNumber, type });
  if (unknown) warnings.push(unknown);
  warnings.push(...checkTddCodeContract(ctx));
  warnings.push(...checkTestsOnlyContract(ctx));
  warnings.push(...checkDocsContract(ctx));
  warnings.push(...checkAllowlistedScope(ctx));
  return warnings;
}

function lintAllPassD(taskModel) {
  if (!taskModel || !Array.isArray(taskModel.tasks)) return [];
  const file = taskModel.file || 'tasks.md';
  const warnings = [];
  for (const task of taskModel.tasks) {
    if (!task) continue;
    const ctx = buildTaskCtx(task, file);
    warnings.push(...lintOneTask(ctx));
  }
  return warnings;
}

module.exports = {
  lintTypeAcConsistency,
  lintAllPassD,
  parseFilesInScope,
  DOCS_EXEMPTION_PATTERNS,
  NEW_BEHAVIOR_PATTERNS,
};
