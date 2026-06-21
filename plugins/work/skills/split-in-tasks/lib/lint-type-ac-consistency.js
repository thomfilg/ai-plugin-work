'use strict';

const {
  isKnownTaskType,
  scopeRulesFor,
  matchesTypeScope,
  isTestFilePath,
  scopeEntryAdmitsOnlyTestFiles,
} = require('./task-types');

// Types that legitimately have no RED/GREEN cycle (exempt from TDD).
// Used to determine when a docs-exemption phrase aligns with the declared Type.
const EXEMPT_TYPES_ANY = Object.freeze([
  'docs',
  'config',
  'ci',
  'tests-only',
  'mechanical-refactor',
  'file-move',
]);

// Each exemption phrase pairs with the set of Types it legitimately aligns
// with. The lint warns only when the declared Type is NOT in that set.
const DOCS_EXEMPTION_RULES = Object.freeze([
  { pattern: /documentation[\s-]*exempt/i, alignedTypes: Object.freeze(['docs']) },
  { pattern: /docs[-\s]?only/i, alignedTypes: Object.freeze(['docs']) },
  {
    pattern: /no\s+RED[\/\s]GREEN(?:[\/\s]REFACTOR)?\s+(?:cycle\s+)?required/i,
    alignedTypes: EXEMPT_TYPES_ANY,
  },
  { pattern: /documentation\/manifest only/i, alignedTypes: Object.freeze(['docs', 'file-move']) },
  { pattern: /config[-\s]?only/i, alignedTypes: Object.freeze(['docs', 'config']) },
  {
    pattern: /manifest[-\s]?only/i,
    alignedTypes: Object.freeze(['docs', 'config', 'file-move']),
  },
  { pattern: /no\s+test(?:able)?\s+surface/i, alignedTypes: EXEMPT_TYPES_ANY },
]);

// Backward-compatible export — list of just the regex patterns.
const DOCS_EXEMPTION_PATTERNS = Object.freeze(DOCS_EXEMPTION_RULES.map((r) => r.pattern));

// "new behavior" markers that should not appear in a tests-only / docs /
// mechanical-refactor / file-move AC. These tasks describe existing-behavior
// coverage or pure transforms, not new feature work.
//
// GH-528 round-2 follow-up ITEM 4 — scope and tuning:
//   findNewBehaviorLine applies these patterns ONLY to the SUMMARY bullet
//   (first AC bullet under `### Acceptance Criteria`). The summary line
//   describes the task's purpose, so "implement"/"fix"/"introduce" there
//   imply real behavior work. Supporting bullets legitimately use the same
//   verbs as low-level steps — "implement the rename across N import paths"
//   is fine in a mechanical-refactor task as long as the SUMMARY says
//   "rename codebase-wide". This kills the false-positive class flagged in
//   the round-2 review without weakening the contract for the summary.
//
//   Patterns are also kept narrow enough to skip refactor-safe phrasings:
//   "rename", "move", "extract" never match; "fix … bug" allows free-form
//   words between fix and bug to catch "fix the auth-token expiry bug".
const NEW_BEHAVIOR_PATTERNS = Object.freeze([
  /\bimplement\b/i,
  /\badd\s+(?:a\s+)?(?:new\s+)?(?:feature|endpoint|api|capability|flag)\b/i,
  /\bfix\s+(?:\w[\w-]*\s+){0,5}?bug\b/i,
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

// Returns { line, alignedTypes } for the first AC line that matches a
// docs-exemption rule, or null if none match.
function findOffendingAcRule(acLines) {
  if (!Array.isArray(acLines)) return null;
  for (const line of acLines) {
    if (typeof line !== 'string') continue;
    for (const rule of DOCS_EXEMPTION_RULES) {
      if (rule.pattern.test(line)) return { line, alignedTypes: rule.alignedTypes };
    }
  }
  return null;
}

// GH-528 round-2 ITEM 4: scope to the SUMMARY bullet only (first AC bullet).
// Supporting bullets can legitimately use "implement"/"fix" as low-level
// verbs without flipping the task's Type semantics. See NEW_BEHAVIOR_PATTERNS
// docblock above for the rationale.
function findNewBehaviorLine(acLines) {
  if (!Array.isArray(acLines)) return null;
  const summary = acLines.find((l) => typeof l === 'string' && l.trim().length > 0);
  if (!summary) return null;
  for (const pattern of NEW_BEHAVIOR_PATTERNS) {
    if (pattern.test(summary)) return summary;
  }
  return null;
}

function makeWarning({ file, taskNumber, message, hint }) {
  return { kind: 'D', file, message: `Task ${taskNumber}: ${message}`, hint };
}

// ── Per-Type checks ─────────────────────────────────────────────────────────

function checkDocsExemptionTypeMismatch({ file, taskNumber, section, acceptanceCriteria }) {
  const offender = findOffendingAcRule(acceptanceCriteria);
  if (!offender) return null;
  const declaredType = parseTaskType(section);
  // Suppress when the declared Type is among the phrase's aligned types.
  if (declaredType && offender.alignedTypes.includes(declaredType)) return null;
  return {
    kind: 'D',
    file,
    message:
      `Task ${taskNumber}: Acceptance Criteria "${offender.line}" declares ` +
      `docs-exemption but Type is "${declaredType || 'unknown'}".`,
    hint: 'propose Type: docs',
  };
}

function checkTddCodeContract({ file, taskNumber, type, filesInScope, acceptanceCriteria }) {
  if (type !== 'tdd-code') return [];
  const warnings = [];
  // GH-594 (Cursor[bot] follow-up): use the shared glob-aware classifier
  // scopeEntryAdmitsOnlyTestFiles for both checks. Tests-only already uses
  // it (line ~217); tdd-code did its own thing with isTestFilePath which
  // happens to agree empirically (the TEST_FILE_PATTERN regex anchors at
  // end-of-string, so `src/**/*.test.js` matches both), but the asymmetry
  // is a drift hazard — any future refactor of either helper risks
  // diverging the two contract checks. Lock them to the same source.
  const hasTest = filesInScope.some(scopeEntryAdmitsOnlyTestFiles);
  const hasSource = filesInScope.some((p) => p && !scopeEntryAdmitsOnlyTestFiles(p));
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
    // Use the shared scope classifier so Pass D and the implement-time
    // Type=tests-only GREEN gate (task-next.js) agree on what counts as
    // a test-only entry — globs whose basename constrains to test files
    // (e.g. `src/**/*.test.js`) must NOT warn while open-ended globs
    // (`src/**`) STILL warn. cursor[bot] follow-up, GH-528.
    const nonTest = filesInScope.filter((p) => !scopeEntryAdmitsOnlyTestFiles(p));
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
