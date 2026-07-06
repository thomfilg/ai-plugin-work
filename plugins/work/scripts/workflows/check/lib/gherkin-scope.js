/**
 * gherkin-scope.js — post-implementation Gherkin scope validation (GH-247).
 *
 * The spec_gate validates Gherkin scenarios BEFORE implementation, but the
 * actual changes may diverge from what the spec anticipated (a
 * `<!-- gherkin-skip: docs-only -->` spec whose implementation ends up
 * touching .tsx files, a @unit-only spec that changes backend routes, …).
 *
 * This module compares:
 *   1. Declared scope (spec.md): skip override + scenario tags
 *      (@unit / @integration / @e2e) via workflows/work/lib/parse-gherkin.js
 *   2. Actual changes: the COMMITTED diff of the ticket worktree
 *      (`git -C <worktree> diff --name-only origin/<BASE>...HEAD`)
 *
 * Detection rules (issue table):
 *   - UI files changed (.tsx/.jsx/.css) but skip / no @e2e   → BLOCK
 *   - backend files (routes/, services/, api/, .sql,
 *     migrations/, …) but skip / no @integration             → BLOCK
 *   - only .md/.yml/config files + gherkin-skip              → PASS
 *   - only test files                                        → PASS
 *   - spec.md absent                                         → WARN (not all
 *     runs have a spec — warn, never block)
 *
 * Path classification reuses the domain classifiers from
 * work-spec/lib/kind-checks/shared.js (isBackendFile / isFrontendFile /
 * isE2eFile) rather than re-inventing the "backend detection challenge"
 * heuristics, extended with the issue's explicit patterns
 * (routes/, services/, api/, middleware/, workers/, migrations/, .sql).
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const { resolveBaseRef } = require('./changed-specs');
const { resolveTicketWorktree } = require(
  path.join(__dirname, '..', '..', 'lib', 'resolve-ticket-worktree')
);
const parseGherkin = require(path.join(__dirname, '..', '..', 'work', 'lib', 'parse-gherkin'));
const { isBackendFile, isE2eFile } = require(
  path.join(__dirname, '..', '..', 'work-spec', 'lib', 'kind-checks', 'shared')
);

// ─── Path classification ────────────────────────────────────────────────────

// Issue rule row 1: UI file types whose change demands @e2e coverage.
const UI_EXT_RE = /\.(tsx|jsx|css|scss|less)$/i;
// Issue rule row 2: explicit backend path/type patterns, on top of the shared
// isBackendFile classifier (app/api/, prisma/, server/, lib schemas).
const BACKEND_PATH_RE = /(^|\/)(routes|services|api|middleware|workers|migrations)(\/|$)/i;
const SQL_RE = /\.sql$/i;
// Test files pass regardless of declared scope (issue rule row 4).
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIR_RE = /(^|\/)(__tests__|__mocks__|tests?)(\/|$)/i;
// Docs / config / CI files — a gherkin-skip is valid for these (row 3).
const DOCS_CONFIG_RE = /\.(md|mdx|markdown|txt|rst|yml|yaml|toml|ini|json|lock|env(\.[\w.-]+)?)$/i;
const CONFIG_NAME_RE = /(^|\/)(\.[^/]+|[^/]*\.config\.[cm]?[jt]s|[^/]*rc)$/i;

function isTestFile(p) {
  return TEST_FILE_RE.test(p) || TEST_DIR_RE.test(p) || isE2eFile(p);
}

function isUiFile(p) {
  return !isTestFile(p) && UI_EXT_RE.test(p);
}

function isBackendChange(p) {
  if (isTestFile(p)) return false;
  return BACKEND_PATH_RE.test(p) || SQL_RE.test(p) || isBackendFile(p);
}

function isDocsOrConfigFile(p) {
  return DOCS_CONFIG_RE.test(p) || CONFIG_NAME_RE.test(p);
}

/**
 * Bucket the changed files. A file can appear in at most one bucket, checked
 * in precedence order: tests → ui → backend → docs/config → other.
 * @param {string[]} files
 */
function classifyChanges(files) {
  const buckets = { tests: [], ui: [], backend: [], docsConfig: [], other: [] };
  for (const f of files) {
    if (isTestFile(f)) buckets.tests.push(f);
    else if (isUiFile(f)) buckets.ui.push(f);
    else if (isBackendChange(f)) buckets.backend.push(f);
    else if (isDocsOrConfigFile(f)) buckets.docsConfig.push(f);
    else buckets.other.push(f);
  }
  return buckets;
}

// ─── Declared scope (spec.md) ───────────────────────────────────────────────

/**
 * Extract the declared Gherkin scope from spec.md text.
 * @param {string|null|undefined} specText
 * @returns {{ hasSpec: boolean, skip: {skip: boolean, reason?: string}, tags: Set<string> }}
 */
function declaredScope(specText) {
  if (!specText || !specText.trim()) {
    return { hasSpec: false, skip: { skip: false }, tags: new Set() };
  }
  const skip = parseGherkin.hasSkipOverride(specText);
  const tags = new Set();
  const parsed = parseGherkin.parse(specText);
  for (const feature of parsed.features) {
    for (const scenario of feature.scenarios) {
      for (const tag of scenario.tags) tags.add(tag.toLowerCase());
    }
  }
  return { hasSpec: true, skip, tags };
}

// ─── Evaluation (pure logic) ────────────────────────────────────────────────

/**
 * Apply the GH-247 detection rules.
 *
 * @param {object} input
 * @param {string|null} input.specText - raw spec.md text (null/'' when absent)
 * @param {string[]} input.files - committed changed files vs base
 * @returns {{
 *   verdict: 'PASS'|'WARN'|'BLOCK',
 *   reasons: string[],
 *   violations: Array<{ requiredTag: string, files: string[], why: string }>,
 *   buckets: ReturnType<typeof classifyChanges>,
 *   declared: ReturnType<typeof declaredScope>,
 * }}
 */
// Rule rows 1 + 2: which change buckets demand which scenario tag.
const SCOPE_RULES = [
  { bucket: 'ui', requiredTag: '@e2e', label: 'UI' },
  { bucket: 'backend', requiredTag: '@integration', label: 'backend' },
];

/** Early PASS/WARN verdicts (rule row 4 + missing spec). Null → keep going. */
function earlyScopeVerdict(files, buckets, declared, base) {
  if (files.length === 0) {
    return {
      ...base,
      verdict: 'PASS',
      reasons: ['No committed changes vs base — nothing to validate.'],
    };
  }

  // Rule row 4: only test files changed → PASS regardless of declared scope.
  if (buckets.tests.length === files.length) {
    return {
      ...base,
      verdict: 'PASS',
      reasons: ['Only test files changed — declared scope is irrelevant.'],
    };
  }

  // Warn-not-block when there is no spec.md (not all runs have one).
  if (!declared.hasSpec) {
    return {
      ...base,
      verdict: 'WARN',
      reasons: [
        'spec.md is absent — declared Gherkin scope cannot be validated against the actual diff. Skipping (warn only).',
      ],
    };
  }

  return null;
}

/** Table-driven rule rows 1 + 2: bucket changed but skip / required tag missing. */
function collectScopeViolations(buckets, declared) {
  const skipDeclared = declared.skip.skip;
  const violations = [];
  for (const { bucket, requiredTag, label } of SCOPE_RULES) {
    const bucketFiles = buckets[bucket];
    if (bucketFiles.length === 0) continue;
    if (!skipDeclared && declared.tags.has(requiredTag)) continue;
    violations.push({
      requiredTag,
      files: bucketFiles,
      why: skipDeclared
        ? `spec declares \`gherkin-skip: ${declared.skip.reason || '(no reason)'}\` but ${label} files changed`
        : `spec has no ${requiredTag}-tagged scenario but ${label} files changed`,
    });
  }
  return violations;
}

function formatViolationReason(v) {
  return `spec scope mismatch: ${v.requiredTag.slice(1)} scenarios required — ${v.why}: ${v.files.join(', ')}`;
}

function evaluateGherkinScope({ specText, files }) {
  const buckets = classifyChanges(files);
  const declared = declaredScope(specText);
  const base = { buckets, declared, violations: [] };

  const early = earlyScopeVerdict(files, buckets, declared, base);
  if (early) return early;

  const violations = collectScopeViolations(buckets, declared);
  if (violations.length > 0) {
    return {
      ...base,
      violations,
      verdict: 'BLOCK',
      reasons: violations.map(formatViolationReason),
    };
  }

  // Rule row 3: only docs/config (+ tests) with a declared skip → skip is valid.
  const nonDocs = files.length - buckets.docsConfig.length - buckets.tests.length;
  if (declared.skip.skip && nonDocs === 0) {
    return {
      ...base,
      verdict: 'PASS',
      reasons: [
        `gherkin-skip (${declared.skip.reason || 'no reason'}) is valid — only docs/config/test files changed.`,
      ],
    };
  }

  return {
    ...base,
    verdict: 'PASS',
    reasons: ['Declared Gherkin scope covers the actual changes.'],
  };
}

// ─── Git side (worktree diff) ───────────────────────────────────────────────

/**
 * Resolve the worktree root cwd-independently (PR #669 review): the ticket id
 * resolves through the shared resolveTicketWorktree (WORKTREES_BASE/REPO_NAME
 * convention first, guarded cwd git-detection second). Only when that yields
 * nothing do we fall back to the ambient `git rev-parse --show-toplevel` —
 * the historical behavior. Every subsequent git call is pinned to the
 * returned root via `git -C`, never the ambient cwd.
 * @param {string} [cwd]
 * @param {string} [ticketId] - e.g. "GH-247"; enables config-based resolution
 * @param {object} [deps] - injectable resolveTicketWorktree opts (tests):
 *   { config, pluginToplevel }
 * @returns {string|null}
 */
function resolveWorktreeRoot(cwd, ticketId, deps = {}) {
  if (ticketId) {
    try {
      const resolved = resolveTicketWorktree(ticketId, { ...(cwd ? { cwd } : {}), ...deps });
      if (resolved) return resolved;
    } catch {
      /* fall through to ambient detection */
    }
  }
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(cwd ? { cwd } : {}),
    }).trim();
  } catch {
    return null;
  }
}

// Refs accepted into a git argv (resolveBaseRef output — defense in depth
// against an env-derived BASE_BRANCH smuggling option-like/shell text).
const SAFE_REF_RE = /^[\w@./:-]+$/;

/**
 * COMMITTED diff vs base (three-dot merge-base diff) — unlike
 * changed-specs.changedFiles this intentionally excludes uncommitted noise:
 * the post-check contract is about what the implementation actually shipped.
 * @param {string} worktree
 * @param {string} baseRef
 * @returns {string[]}
 */
function committedChangedFiles(worktree, baseRef) {
  if (!SAFE_REF_RE.test(String(baseRef || ''))) return [];
  try {
    // No shell: argv array, so worktree/baseRef are never shell-interpreted.
    return execFileSync('git', ['-C', worktree, 'diff', '--name-only', `${baseRef}...HEAD`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Full pipeline: resolve worktree + base, diff, evaluate.
 * Fail-open on unresolvable git state (verdict WARN, never BLOCK).
 * @param {{ specText: string|null, cwd?: string, ticketId?: string }} input
 */
function runGherkinScopeCheck({ specText, cwd, ticketId }) {
  const worktree = resolveWorktreeRoot(cwd, ticketId);
  if (!worktree) {
    return {
      verdict: 'WARN',
      reasons: ['Worktree unresolvable (not a git repo?) — Gherkin scope not validated.'],
      violations: [],
      buckets: classifyChanges([]),
      declared: declaredScope(specText),
      worktree: null,
      baseRef: null,
      files: [],
    };
  }
  const baseRef = resolveBaseRef(worktree);
  if (!baseRef) {
    return {
      verdict: 'WARN',
      reasons: ['Base ref unresolvable (no origin/main|master|dev) — Gherkin scope not validated.'],
      violations: [],
      buckets: classifyChanges([]),
      declared: declaredScope(specText),
      worktree,
      baseRef: null,
      files: [],
    };
  }
  const files = committedChangedFiles(worktree, baseRef);
  return { ...evaluateGherkinScope({ specText, files }), worktree, baseRef, files };
}

module.exports = {
  classifyChanges,
  declaredScope,
  evaluateGherkinScope,
  resolveWorktreeRoot,
  committedChangedFiles,
  runGherkinScopeCheck,
  isTestFile,
  isUiFile,
  isBackendChange,
  isDocsOrConfigFile,
};
