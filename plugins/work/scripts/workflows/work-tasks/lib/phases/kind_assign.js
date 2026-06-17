/**
 * Phase: kind_assign — every task has a recognized `### Type` value AND
 * per-kind sanity checks pass.
 *
 * - backend: at least one `*.integration.test.*` file in scope.
 * - frontend: at least one component / page / hook file in scope.
 * - e2e: at least one tests/e2e Playwright spec file in scope.
 * - wiring: NO file in `Files in scope` matches the backend pattern when
 *   `Files explicitly out of scope` mentions a backend file (the ECHO-4579
 *   defense at task granularity).
 * - devops: only infra/config files (`.github/`, `scripts/`, `*.yml`,
 *   Dockerfile) in scope.
 * - checkpoint: no per-kind sanity (just a synchronization marker).
 */

'use strict';

const { TASKS_PHASES } = require('../../tasks-phase-registry');
const { iterTaskBlocks } = require('./_task-block-iter');
const { loadTasksMd, readFileSafe, tasksMdPath } = require('./_tasks-md-loader');

const VALID_KINDS = new Set([
  'frontend',
  'backend',
  'wiring',
  'e2e',
  'devops',
  'fullstack',
  'checkpoint',
]);

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

function isBackendFile(p) {
  return (
    /(^|\/)app\/api\//.test(p) ||
    /(^|\/)lib\/.*\/schemas?\.(ts|js)$/.test(p) ||
    /(^|\/)prisma\//.test(p) ||
    /(^|\/)server\//.test(p)
  );
}
function isFrontendFile(p) {
  return (
    /(^|\/)components\//.test(p) ||
    /(^|\/)app\/.*\.(tsx|jsx)$/.test(p) ||
    /(^|\/)hooks\//.test(p) ||
    /(^|\/)pages\//.test(p)
  );
}
function isE2eFile(p) {
  return /(^|\/)tests\/e2e\//.test(p) || /\.spec\.(ts|tsx|js|jsx)$/.test(p);
}
function isIntegrationTest(p) {
  return /\.integration\.test\.(ts|tsx|js|jsx)$/.test(p);
}
function isDevopsFile(p) {
  return (
    /^\.github\//.test(p) ||
    /(^|\/)scripts\//.test(p) ||
    /\.(yml|yaml)$/.test(p) ||
    /(^|\/)Dockerfile/.test(p)
  );
}
function isAppSourceFile(p) {
  return /(^|\/)app\//.test(p) || /(^|\/)lib\//.test(p) || /(^|\/)components\//.test(p);
}

// Per-kind validators — each returns an array of error strings for the block.
// Keeping these as small named functions lets `validateBlock` stay a flat
// dispatch (cc = 3) instead of a giant if/else ladder.

function _validateBackend(b) {
  if (b.filesInScope.some(isIntegrationTest)) return [];
  return [
    `Task ${b.num} kind=backend but no \`*.integration.test.*\` file in \`### Files in scope\`. Backend tasks must ship with integration test coverage.`,
  ];
}

function _validateFrontend(b) {
  if (b.filesInScope.some(isFrontendFile)) return [];
  return [`Task ${b.num} kind=frontend but no component/page/hook file in \`### Files in scope\`.`];
}

function _validateE2e(b) {
  if (b.filesInScope.some(isE2eFile)) return [];
  return [
    `Task ${b.num} kind=e2e but no \`tests/e2e/**/*.spec.*\` file in \`### Files in scope\`.`,
  ];
}

function _validateWiring(b) {
  const backendDrift = b.filesInScope.filter(isBackendFile);
  if (!backendDrift.length) return [];
  return [
    `Task ${b.num} kind=wiring but \`### Files in scope\` includes backend files (${backendDrift
      .map((f) => `\`${f}\``)
      .join(
        ', '
      )}). Wiring tasks must not touch backend — escalate to a sibling owner instead. (ECHO-4579 defense at task granularity.)`,
  ];
}

function _validateDevops(b) {
  const errors = [];
  const appDrift = b.filesInScope.filter(isAppSourceFile);
  if (appDrift.length) {
    errors.push(
      `Task ${b.num} kind=devops but \`### Files in scope\` includes app-source files (${appDrift
        .map((f) => `\`${f}\``)
        .join(', ')}). Split into a separate task with a different kind.`
    );
  }
  if (!b.filesInScope.some(isDevopsFile)) {
    errors.push(
      `Task ${b.num} kind=devops but no infra file (\`.github/\`, \`scripts/\`, \`*.yml\`, \`Dockerfile\`) in scope.`
    );
  }
  return errors;
}

// Dispatch table keyed on `### Type`. checkpoint + fullstack have no extra
// per-kind sanity (fullstack intentionally accepts any mix); both map to a
// no-op validator.
const _KIND_VALIDATORS = {
  backend: _validateBackend,
  frontend: _validateFrontend,
  e2e: _validateE2e,
  wiring: _validateWiring,
  devops: _validateDevops,
  fullstack: () => [],
  checkpoint: () => [],
};

function validateBlock(b) {
  if (!VALID_KINDS.has(b.type)) {
    return [
      `Task ${b.num} \`### Type\` is "${b.type}" — must be one of: ${[...VALID_KINDS].join(', ')}.`,
    ];
  }
  const validator = _KIND_VALIDATORS[b.type];
  return validator ? validator(b) : [];
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
    `- Every task's \`### Type\` is one of: ${[...VALID_KINDS].join(', ')}.`,
    '- backend tasks have a `*.integration.test.*` in scope.',
    '- frontend tasks have a component / page / hook file in scope.',
    '- e2e tasks have a `tests/e2e/**/*.spec.*` file in scope.',
    '- wiring tasks have NO backend file in scope (ECHO-4579 defense).',
    '- devops tasks touch only infra/config; no app/lib/components.',
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
