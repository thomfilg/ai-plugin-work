'use strict';

/**
 * task-types.js — Closed enum for the `### Type` field in tasks.md.
 *
 * Single source of truth for which gate contract a task gets at implement time.
 * The planner (split-in-tasks) writes ONE of these values into each task's
 * `### Type` line; the implementer (task-next.js / tdd-phase-state.js) reads it
 * and applies the matching contract. The implementer must not be able to
 * promote a TDD-required task to a TDD-exempt one — that decision belongs to
 * the planner and is enforced by hooks (protect-task-scope.js + a Type-line
 * edit guard).
 *
 * Adding a new Type: add it to either TDD_REQUIRED_TYPES or TDD_EXEMPT_TYPES
 * (never both), and extend gateContractFor() with its rcdEmptyTrap /
 * redRequiresTestFiles flags. Pass D (lib/lint-type-ac-consistency.js) will
 * pick it up automatically through allTaskTypes().
 */

const TDD_REQUIRED_TYPES = Object.freeze(['tdd-code']);

const TDD_EXEMPT_TYPES = Object.freeze([
  'tests-only',
  'docs',
  'config',
  'ci',
  'mechanical-refactor',
  'file-move',
  'checkpoint',
]);

const TASK_TYPES = Object.freeze([...TDD_REQUIRED_TYPES, ...TDD_EXEMPT_TYPES]);

function normalize(t) {
  if (typeof t !== 'string') return '';
  return t.trim().toLowerCase();
}

function isKnownTaskType(t) {
  return TASK_TYPES.includes(normalize(t));
}

function isTddRequired(t) {
  return TDD_REQUIRED_TYPES.includes(normalize(t));
}

function isTddExempt(t) {
  return TDD_EXEMPT_TYPES.includes(normalize(t));
}

function allTaskTypes() {
  return TASK_TYPES.slice();
}

/**
 * Per-Type gate contract returned to the implementer.
 *
 * Fields:
 *   - kind                 — the canonical Type string
 *   - redRequiresTestFiles — if true, RED phase requires modified *.test.* /
 *                            *.spec.* files in scope (tdd-code only)
 *   - rcdEmptyTrap         — if true, GREEN / REFACTOR refuse exit-0 with no
 *                            stdout/stderr (RC-D defense in tdd-phase-state.js)
 *
 * Unknown types fall back to the strictest contract (tdd-code) so missing
 * planner data fails closed.
 */
function gateContractFor(type /* , _scope */) {
  const t = normalize(type);
  switch (t) {
    case 'tdd-code':
      return { kind: 'tdd-code', redRequiresTestFiles: true, rcdEmptyTrap: true };
    case 'tests-only':
      return { kind: 'tests-only', redRequiresTestFiles: false, rcdEmptyTrap: true };
    case 'docs':
      return { kind: 'docs', redRequiresTestFiles: false, rcdEmptyTrap: false };
    case 'config':
      return { kind: 'config', redRequiresTestFiles: false, rcdEmptyTrap: false };
    case 'ci':
      return { kind: 'ci', redRequiresTestFiles: false, rcdEmptyTrap: false };
    case 'mechanical-refactor':
      return { kind: 'mechanical-refactor', redRequiresTestFiles: false, rcdEmptyTrap: true };
    case 'file-move':
      return { kind: 'file-move', redRequiresTestFiles: false, rcdEmptyTrap: false };
    case 'checkpoint':
      return { kind: 'checkpoint', redRequiresTestFiles: false, rcdEmptyTrap: false };
    default:
      // Unknown / freeform Type → strictest contract. Planner-side Pass D
      // should reject this before reaching the implementer, but failing
      // closed here keeps a defense-in-depth layer.
      return { kind: 'tdd-code', redRequiresTestFiles: true, rcdEmptyTrap: true };
  }
}

/**
 * Per-Type file-pattern allowlist (regex source strings — RE2-compatible).
 *
 * Used by:
 *   - Pass D (lib/lint-type-ac-consistency.js) at planner time to verify each
 *     task's `### Files in scope` matches the contract for its declared Type.
 *   - protect-task-scope.js at implementer time to block write targets that
 *     don't match the active task's Type allowlist.
 *
 * Semantics:
 *   - Each pattern matches against a relative POSIX path (forward slashes).
 *   - "scopeMatchAll" means every scope entry must match at least one pattern.
 *   - "scopeMatchAny" means the patterns are advisory — scope is unconstrained
 *     beyond the kind's primary contract (used for tdd-code / checkpoint).
 *   - `mustHaveSource` true requires at least one non-test source entry
 *     (used by tdd-code Pass D check).
 *   - `mustHaveTest` true requires at least one *.test.* / *.spec.* entry.
 *   - `mustBeOnlyTests` true requires the scope to consist ONLY of test files.
 *   - `acForbidNewBehavior` true marks types whose AC must not describe
 *     "implement"/"add feature"/"fix bug" wording (warn at planner time).
 *
 * Config allowlist (Type=config) is intentionally narrow — only files the
 * planner would call "configuration" at decomposition time. Build/runtime
 * config that ships behavior (e.g. webpack.config.js exporting a plugin
 * factory) does NOT belong here — that is `tdd-code`.
 */
const TEST_FILE_PATTERN = '\\.(test|spec)\\.[jt]sx?$';

const TYPE_SCOPE_RULES = Object.freeze({
  'tdd-code': Object.freeze({
    scopePatterns: null, // unconstrained
    mustHaveTest: true,
    mustHaveSource: true,
    mustBeOnlyTests: false,
    acForbidNewBehavior: false,
  }),
  'tests-only': Object.freeze({
    scopePatterns: Object.freeze([TEST_FILE_PATTERN]),
    mustHaveTest: true,
    mustHaveSource: false,
    mustBeOnlyTests: true,
    acForbidNewBehavior: true,
  }),
  docs: Object.freeze({
    scopePatterns: Object.freeze(['\\.md$']),
    mustHaveTest: false,
    mustHaveSource: false,
    mustBeOnlyTests: false,
    acForbidNewBehavior: true,
  }),
  config: Object.freeze({
    // Narrow allowlist — packaging manifests, formatter configs, env files.
    // Build configs that ship behavior (rollup.config.js, vite plugins,
    // webpack loaders) belong to `tdd-code`, not `config`.
    scopePatterns: Object.freeze([
      '(^|/)package\\.json$',
      '(^|/)package-lock\\.json$',
      '(^|/)pnpm-lock\\.yaml$',
      '(^|/)pnpm-workspace\\.yaml$',
      '(^|/)tsconfig(\\.[^/]*)?\\.json$',
      '(^|/)\\.eslintrc(\\.[^/]*)?$',
      '(^|/)eslint\\.config\\.[cm]?js$',
      '(^|/)biome\\.json$',
      '(^|/)\\.prettierrc(\\.[^/]*)?$',
      '(^|/)prettier\\.config\\.[cm]?js$',
      '(^|/)\\.editorconfig$',
      '(^|/)\\.nvmrc$',
      '(^|/)\\.node-version$',
      '(^|/)\\.envrc$',
      '(^|/)\\.env(\\.[^/]*)?$',
      '(^|/)\\.gitignore$',
      '(^|/)\\.gitattributes$',
      '(^|/)\\.quality-exceptions$',
      '(^|/)turbo\\.json$',
      '(^|/)nx\\.json$',
    ]),
    mustHaveTest: false,
    mustHaveSource: false,
    mustBeOnlyTests: false,
    acForbidNewBehavior: false,
  }),
  ci: Object.freeze({
    scopePatterns: Object.freeze([
      '(^|/)\\.github/.*',
      '(^|/)\\.circleci/.*',
      '(^|/)\\.gitlab-ci\\.yml$',
      '(^|/)azure-pipelines\\.ya?ml$',
      '(^|/)\\.buildkite/.*',
      '(^|/)\\.woodpecker(\\.ya?ml|/.*)$',
      '(^|/)Jenkinsfile$',
    ]),
    mustHaveTest: false,
    mustHaveSource: false,
    mustBeOnlyTests: false,
    acForbidNewBehavior: false,
  }),
  'mechanical-refactor': Object.freeze({
    scopePatterns: null,
    mustHaveTest: false,
    mustHaveSource: false,
    mustBeOnlyTests: false,
    acForbidNewBehavior: true,
  }),
  'file-move': Object.freeze({
    scopePatterns: null,
    mustHaveTest: false,
    mustHaveSource: false,
    mustBeOnlyTests: false,
    acForbidNewBehavior: true,
  }),
  checkpoint: Object.freeze({
    scopePatterns: null,
    mustHaveTest: false,
    mustHaveSource: false,
    mustBeOnlyTests: false,
    acForbidNewBehavior: false,
  }),
});

/**
 * Look up the scope/AC rules for a Type. Unknown types return null so callers
 * can decide their own fallback (Pass D treats unknown as "skip kind-D scope
 * checks" — the freeform-Type warning is emitted by the existing kind-D
 * docs-exemption check instead).
 */
function scopeRulesFor(type) {
  const t = normalize(type);
  return TYPE_SCOPE_RULES[t] || null;
}

/**
 * Return true if the relative path matches any of the Type's scope patterns.
 * Used by Pass D and protect-task-scope.js. Always compares as POSIX path.
 */
function matchesTypeScope(type, relPath) {
  const rules = scopeRulesFor(type);
  if (!rules || !rules.scopePatterns) return true; // unconstrained
  const posix = String(relPath || '').replace(/\\/g, '/');
  for (const src of rules.scopePatterns) {
    if (new RegExp(src).test(posix)) return true;
  }
  return false;
}

function isTestFilePath(relPath) {
  return new RegExp(TEST_FILE_PATTERN).test(String(relPath || '').replace(/\\/g, '/'));
}

/**
 * scopeEntryAdmitsOnlyTestFiles — true iff a `### Files in scope` entry can
 * ONLY match test files (`*.test.<ext>` / `*.spec.<ext>`). Shared classifier
 * for the planner-time Pass D gate (lint-type-ac-consistency.js) and the
 * implement-time Type=tests-only GREEN gate (task-next.js) — keeping both
 * sides on the same function prevents drift (cursor[bot] follow-up, GH-528).
 *
 * Rules:
 *   - Empty / non-string                                     → false.
 *   - Glob entry (contains `*`): inspect its basename — the segment after
 *     the last `/`. Accept iff the basename ends in `*.test.<ext>` /
 *     `*.spec.<ext>`. This accepts `src/**\/*.test.js` and rejects
 *     `src/**`, `lib/**\/*.js`.
 *   - Literal entry: delegate to `isTestFilePath`. Accept `src/foo.test.js`,
 *     reject `src/foo.js`.
 *
 * @param {string} entry
 * @returns {boolean}
 */
function scopeEntryAdmitsOnlyTestFiles(entry) {
  if (typeof entry !== 'string' || !entry) return false;
  const isGlob = entry.includes('*');
  if (!isGlob) {
    return isTestFilePath(entry);
  }
  // Glob: examine the basename. A glob whose final segment ends in a
  // test-file extension pattern admits ONLY test files; any other shape
  // could match a non-test file.
  const lastSlash = entry.lastIndexOf('/');
  const basename = lastSlash >= 0 ? entry.slice(lastSlash + 1) : entry;
  return new RegExp(TEST_FILE_PATTERN).test(basename);
}

module.exports = {
  TASK_TYPES,
  TDD_REQUIRED_TYPES,
  TDD_EXEMPT_TYPES,
  TYPE_SCOPE_RULES,
  TEST_FILE_PATTERN,
  isKnownTaskType,
  isTddRequired,
  isTddExempt,
  allTaskTypes,
  gateContractFor,
  scopeRulesFor,
  matchesTypeScope,
  isTestFilePath,
  scopeEntryAdmitsOnlyTestFiles,
};
