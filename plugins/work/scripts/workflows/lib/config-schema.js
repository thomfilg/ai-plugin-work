'use strict';

/**
 * config-schema.js
 *
 * Descriptor map of every configuration key read by `config.js`. This is the
 * single source of truth for "known config keys" used by the startup validator
 * (`config-validate.js`): the unknown-key scan and the value-format validation
 * both derive from `SCHEMA`. Adding one entry here extends both scans with no
 * other edit (R10).
 *
 * This module ONLY declares known keys and their expected value formats — it
 * does NOT duplicate any of config.js's resolution / defaulting logic.
 *
 * Entry shape: `{ type, allowed?, pattern?, prefix?, description? }`
 *   type        one of: 'flag01' | 'bool' | 'enum' | 'json-array' | 'string'
 *   allowed     enum values (required for type 'enum')
 *   pattern     optional RegExp the raw string value must match
 *   prefix      optional prefix tag (one of PREFIXES) for grouping
 *   description optional human-readable note
 *
 * Type semantics (interpreted by config-validate.js):
 *   flag01      '0' or '1'
 *   bool        true/false, case-insensitive ('true'/'false')
 *   enum        value must be a member of `allowed`
 *   json-array  parseable JSON that yields an array
 *   string      any value (always valid)
 */

const PREFIXES = ['WORK_', 'ENABLE_', 'TICKET_'];

// ─── Entry builders ─────────────────────────────────────────────────────────
// Small constructors keep the descriptor map terse and uniform.

const flag01 = (description) => ({ type: 'flag01', description });
const bool = (description) => ({ type: 'bool', description });
const enumOf = (allowed, description) => ({ type: 'enum', allowed, description });
const jsonArray = (description) => ({ type: 'json-array', description });
const str = (description) => ({ type: 'string', description });

const SCHEMA = Object.freeze({
  // ── Legacy Jira vars (non-prefixed) ──────────────────────────────────────
  JIRA_PROJECT_KEY: str('Legacy Jira project key.'),
  JIRA_BASE_URL: str('Legacy Jira base URL.'),
  JIRA_ASSIGNEE_EMAIL: str('Legacy Jira assignee email.'),

  // ── Provider-agnostic ticket config (TICKET_ prefix) ─────────────────────
  TICKET_PROVIDER: enumOf(['jira', 'linear', 'github', 'none', ''], 'Ticket provider backend.'),
  TICKET_PROJECT_KEY: str('Provider-agnostic project key.'),

  // ── Repository / worktree layout (non-prefixed) ──────────────────────────
  REPO_NAME: str('Repository name used in worktree paths.'),
  GITHUB_ORG: str('GitHub organization/owner.'),
  WORKTREES_BASE: str('Base directory holding worktrees.'),
  TASKS_BASE: str('Base directory holding per-ticket task folders.'),

  // ── Feature flags ────────────────────────────────────────────────────────
  ENABLE_SYMLINK: flag01("Enable symlink behavior ('0' off, '1' on)."),
  WORK_TEST_STRATEGY_VALIDATOR: flag01("Gate the tasks-draft Test Strategy validator ('0'/'1')."),

  // ── Follow-up behavior ───────────────────────────────────────────────────
  FOLLOW_UP_PR_POLL_REVIEWS: bool('Poll PR reviews during follow-up.'),

  // ── Docs to read per workflow phase (non-prefixed) ───────────────────────
  READ_DOCS_ON_REVIEW: str('Comma-separated docs to read during review.'),
  READ_DOCS_ON_QA: str('Comma-separated docs to read during QA.'),
  READ_DOCS_ON_DEV: str('Comma-separated docs to read during development.'),
  READ_DOCS_ON_E2E: str('Comma-separated docs to read during e2e.'),
  READ_DOCS_ON_TEST: str('Comma-separated docs to read during testing.'),
  READ_DOCS_ON_STORYBOOK: str('Comma-separated docs to read during storybook.'),
  READ_DOCS_ON_PR: str('Comma-separated docs to read during PR authoring.'),
  READ_DOCS_ON_BRIEF: str('Comma-separated docs to read during brief.'),
  READ_DOCS_ON_SPEC: str('Comma-separated docs to read during spec.'),

  // ── Base branch ──────────────────────────────────────────────────────────
  BASE_BRANCH: str('Repo base branch (e.g. main, dev, master).'),

  // ── Custom commands ──────────────────────────────────────────────────────
  DEV_COMMAND: str('Command to start the dev environment.'),
  TEST_COMMAND: str('Legacy test command.'),
  LINT_COMMAND: str('Linter command.'),
  TYPECHECK_COMMAND: str('Type checker command.'),

  // ── Per-suite scoped test commands ───────────────────────────────────────
  TEST_UNIT_COMMAND: str('Scoped unit test command (uses $CHANGED_FILES).'),
  TEST_INTEGRATION_COMMAND: str('Scoped integration test command (uses $CHANGED_FILES).'),
  TEST_E2E_COMMAND: str('Scoped e2e test command (uses $CHANGED_FILES).'),

  // ── Per-suite "run affected" scripts ─────────────────────────────────────
  SCRIPT_RUN_AFFECTED_UNIT: str('Affected-unit-test runner script.'),
  SCRIPT_RUN_AFFECTED_INTEGRATION: str('Affected-integration-test runner script.'),
  SCRIPT_RUN_AFFECTED_E2E: str('Affected-e2e-test runner script.'),

  // ── Web apps list ────────────────────────────────────────────────────────
  WEB_APPS: jsonArray('JSON array of web app descriptors.'),

  // ── Cost reporting (GH-311) ──────────────────────────────────────────────
  WORK_PRICING: str(
    'Model-keyed JSON pricing table ({ <model>: { usdPer1MTokens } }) for the reports-step cost estimate; invalid JSON falls back to the built-in default.'
  ),
});

const KNOWN_KEYS = Object.keys(SCHEMA);

module.exports = { SCHEMA, KNOWN_KEYS, PREFIXES };
