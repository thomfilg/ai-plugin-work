/**
 * Phase: kind_assign — every task has a recognized `### Type` value AND
 * per-Type structural scope checks pass.
 *
 * The `### Type` enum is the closed gate-contract taxonomy defined in
 * skills/split-in-tasks/lib/task-types.js (tdd-code | tests-only | docs |
 * config | ci | mechanical-refactor | file-move | checkpoint). It is the
 * SAME enum the implement gate reads via `gateContractFor()` — validating a
 * different vocabulary here is exactly the drift that wedged docs/devops
 * tasks at RED (GH-498 / issues #489, #606): kind_assign used to demand the
 * legacy domain kinds (frontend/backend/wiring/e2e/devops/fullstack) which
 * `gateContractFor()` does not know, so every non-checkpoint task fell back
 * to the strictest fail-closed tdd-code contract at implement.
 *
 * Structural checks derive from TYPE_SCOPE_RULES (same source Pass D and
 * protect-task-scope.js use):
 *   - scopePatterns  — every `### Files in scope` entry must match the
 *     Type's allowlist (docs → *.md, config/ci → their allowlists).
 *   - mustHaveTest   — tdd-code / tests-only need a test-authorship entry,
 *     otherwise the RED gate is unsatisfiable at implement.
 *   - mustHaveSource — tdd-code needs at least one non-test source entry.
 */

'use strict';

const { TASKS_PHASES } = require('../../tasks-phase-registry');
const { iterTaskBlocks } = require('./_task-block-iter');
const { loadTasksMd, readFileSafe, tasksMdPath } = require('./_tasks-md-loader');
const {
  TASK_TYPES,
  isKnownTaskType,
  scopeRulesFor,
  matchesTypeScope,
  scopeEntryAdmitsOnlyTestFiles,
} = require('../../../../../skills/split-in-tasks/lib/task-types');

// Derived from the canonical closed enum — kept exported under the historical
// name because work-state/task-readiness.js allowlists persisted task kinds
// against this set.
const VALID_KINDS = new Set(TASK_TYPES);

// Migration hints for the legacy domain-kind vocabulary this phase used to
// accept. Emitted alongside the unknown-Type error so the planner converges
// in one pass instead of guessing.
const LEGACY_KIND_HINTS = Object.freeze({
  frontend: '`tdd-code`',
  backend: '`tdd-code`',
  fullstack: '`tdd-code`',
  wiring: '`tdd-code` (or `mechanical-refactor` for pure re-wiring with no behavior change)',
  e2e: '`tdd-code` (or `tests-only` when the task only adds e2e specs)',
  devops:
    '`ci` (CI configs), `config` (inert configuration), or `tdd-code` (scripts that ship behavior)',
});

function parseBlocks(text) {
  const out = [];
  for (const { num, body } of iterTaskBlocks(text)) {
    const typeMatch = body.match(/###\s+Type\s*\n([^\n#]+)/);
    const type = typeMatch ? typeMatch[1].trim().toLowerCase() : 'unknown';
    // See note in traceability.js — `$` in multiline mode matches every
    // end-of-line, which terminates the non-greedy match prematurely.
    const filesInScope = extractScopeList(
      body.match(/###\s+Files in scope[^\n]*\n([\s\S]*?)(?=\n###\s|\n## |$(?![\s\S]))/)
    );
    const filesOutOfScope = extractScopeList(
      body.match(
        /###\s+Files explicitly out of scope[^\n]*\n([\s\S]*?)(?=\n###\s|\n## |$(?![\s\S]))/
      )
    );
    out.push({ num: Number(num), type, filesInScope, filesOutOfScope });
  }
  return out;
}

function extractScopeList(match) {
  if (!match) return [];
  const out = new Set();
  const re = /`([^`\n]+)`/g;
  let m;
  while ((m = re.exec(match[1])) !== null) out.add(m[1].trim());
  return [...out];
}

function _unknownTypeError(b) {
  const base = `Task ${b.num} \`### Type\` is "${b.type}" — must be one of: ${TASK_TYPES.join(', ')}.`;
  const hint = LEGACY_KIND_HINTS[b.type];
  if (!hint) return base;
  return `${base} Legacy kind "${b.type}" maps to ${hint}. The \`### Type\` field drives the implement-time gate contract (gateContractFor in task-types.js); unknown values fall back to the strictest tdd-code contract and wedge non-code tasks at RED.`;
}

function _scopePatternErrors(b, rules) {
  if (!rules.scopePatterns) return [];
  const offenders = b.filesInScope.filter((p) => !matchesTypeScope(b.type, p));
  if (!offenders.length) return [];
  return [
    `Task ${b.num} Type=${b.type} but \`### Files in scope\` includes entries outside the ${b.type} allowlist (${offenders
      .map((f) => `\`${f}\``)
      .join(', ')}). Move them to a task whose Type covers them, or change this task's Type.`,
  ];
}

function _testSurfaceErrors(b, rules) {
  const errors = [];
  if (rules.mustHaveTest && !b.filesInScope.some(scopeEntryAdmitsOnlyTestFiles)) {
    errors.push(
      `Task ${b.num} Type=${b.type} requires at least one \`*.test.*\` / \`*.spec.*\` entry in \`### Files in scope\` — without a test-authorship surface the RED gate is unsatisfiable at implement.`
    );
  }
  if (rules.mustHaveSource && !b.filesInScope.some((p) => !scopeEntryAdmitsOnlyTestFiles(p))) {
    errors.push(
      `Task ${b.num} Type=${b.type} requires at least one non-test source entry in \`### Files in scope\`.`
    );
  }
  return errors;
}

function validateBlock(b) {
  if (!isKnownTaskType(b.type)) return [_unknownTypeError(b)];
  const rules = scopeRulesFor(b.type);
  if (!rules) return [];
  return [..._scopePatternErrors(b, rules), ..._testSurfaceErrors(b, rules)];
}

function validateArtifacts(tasksDir) {
  const { text, errors } = loadTasksMd(tasksDir, (p) => `Missing ${p}.`);
  if (text === null) return errors;
  const blocks = parseBlocks(text);
  if (!blocks.length) {
    errors.push('No `## Task N` blocks — re-run draft phase first.');
    return errors;
  }
  for (const b of blocks) errors.push(...validateBlock(b));
  return errors;
}

function validate(ctx) {
  const errors = validateArtifacts(ctx.tasksDir);
  if (errors.length) return { ok: false, errors };
  const text = readFileSafe(tasksMdPath(ctx.tasksDir));
  const blocks = parseBlocks(text);
  return {
    ok: true,
    summary: `${blocks.length} task(s) — kinds: ${[...new Set(blocks.map((b) => b.type))].join(', ')}`,
  };
}

function instructions(ctx) {
  return [
    `# tasks-next — Phase 5 of 7: KIND ASSIGN`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What I check',
    `- Every task's \`### Type\` is one of the closed gate-contract enum: ${TASK_TYPES.join(', ')} (see skills/split-in-tasks/docs/output-format.md).`,
    '- tdd-code tasks have a `*.test.*` / `*.spec.*` entry AND a non-test source entry in scope.',
    '- tests-only tasks list ONLY test files in scope.',
    '- docs tasks list ONLY `*.md` files in scope.',
    '- config / ci tasks stay inside their file allowlists (task-types.js TYPE_SCOPE_RULES).',
    '- checkpoint / mechanical-refactor / file-move have no scope-pattern constraint.',
    '',
    'Re-invoke me to verify.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASKS_PHASES.kind_assign, {
    next: TASKS_PHASES.scope_exists,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.validateArtifacts = validateArtifacts;
module.exports.parseBlocks = parseBlocks;
module.exports.VALID_KINDS = VALID_KINDS;
