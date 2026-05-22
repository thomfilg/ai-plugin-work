#!/usr/bin/env node

/**
 * PreToolUse hook: Block agent writes to ANY orchestrator-managed state
 * file under <TASKS_BASE>/<ticket>/.
 *
 * The /work orchestrator and its gates are the only legitimate writers of
 * the workflow state machine, TDD evidence, archival folders, and per-task
 * review artifacts. Those writers all use fs.writeFileSync from inside the
 * orchestrator process, so they bypass PreToolUse hooks by construction.
 * Consequently, anything matching one of the patterns below MUST come from
 * an agent tool call — and must be blocked.
 *
 * Failure mode this prevents: in PR #362 we locked tdd-phase.json. Hours
 * later, an agent advanced its workflow by hand-editing .work-state.json
 * to skip the brief step. This hook is the consolidated deny-list that
 * closes every such doorway.
 *
 * Coverage:
 *   - .work-state.json (and .bak* rotations)
 *   - .work.pid
 *   - .last-commit-sha
 *   - .work-actions.json
 *   - .claims/ — every file under
 *   - task<N>/tdd-phase.json (supersedes protect-tdd-phase.js)
 *   - task<N>/task-review-{tests,code}.md
 *   - runs/run<N>/ — every file under
 *   - archives/ and .archive/ — every file under
 */

'use strict';

const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));
const { createFileProtector } = require(
  path.join(__dirname, '..', '..', 'lib', 'protect-state-files')
);

// ─── Protected paths ────────────────────────────────────────────────────────

/** Bare basenames the orchestrator manages; agents must never write these. */
const PROTECTED_BASENAMES = new Set([
  '.work-state.json',
  '.work.pid',
  '.last-commit-sha',
  '.work-actions.json',
  'tdd-phase.json',
  'task-review-tests.md',
  'task-review-code.md',
]);

const WORK_STATE_BAK_RE = /^\.work-state\.json\.bak[\w.-]*$/;
const CLAIMS_DIR_RE = /(?:^|[\\/])\.claims[\\/]/;
const RUNS_RUN_DIR_RE = /(?:^|[\\/])runs[\\/]run\d+[\\/]/;
const ARCHIVE_DIR_RE = /(?:^|[\\/])\.?archives?[\\/]/;

/**
 * Decide whether a candidate path is orchestrator-managed.
 * Returns a label (matched basename or directory-anchored hint) or null.
 *
 * Composes basename-set matching with directory-segment checks. The
 * directory checks anchor on a separator so a user file literally named
 * "myruns/foo" never collides with our "runs/run<N>/" pattern.
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function isOrchestratorManaged(filePath) {
  const fp = String(filePath || '');
  if (!fp) return null;
  const bn = path.basename(fp);
  if (PROTECTED_BASENAMES.has(bn)) return bn;
  if (WORK_STATE_BAK_RE.test(bn)) return bn;
  if (CLAIMS_DIR_RE.test(fp)) return `.claims/${bn || '<dir>'}`;
  if (RUNS_RUN_DIR_RE.test(fp)) return `runs/${bn || '<dir>'}`;
  if (ARCHIVE_DIR_RE.test(fp)) return `archive/${bn || '<dir>'}`;
  return null;
}

// ─── Block message ──────────────────────────────────────────────────────────

function formatMessage(match, vector) {
  return [
    `BLOCKED: ${match} is orchestrator-managed and cannot be written by agents (vector: ${vector}).`,
    '',
    `Why: This file belongs to the /work state machine. The orchestrator and`,
    `     gates are the only legitimate writers — direct agent edits would`,
    `     corrupt the state machine and falsify the audit trail.`,
    '',
    'What to do instead:',
    '  - Workflow advancement: re-run the /work driver (it advances steps',
    '    automatically). Never hand-edit currentStep or stepStatus.',
    '  - TDD evidence: implement the task; the implement-gate runs your',
    '    test command and records evidence on its own.',
    '  - Review artifacts: produced by the task_review gate. Do NOT write',
    '    task<N>/task-review-*.md by hand.',
    '  - Locks / SHA / claims / archives: managed by the orchestrator.',
    '    Never delete or edit.',
    '',
    'If you believe a state file is corrupted and needs manual repair,',
    'stop and ask the user.',
    '',
  ].join('\n');
}

// ─── Hook entrypoint ────────────────────────────────────────────────────────

// Plugin root contains every legitimate writer of the protected basenames
// (work-next.js, transition-step.js, tdd-phase-state.js, the gate scripts).
// Declaring it as a trusted script root prevents Vector 3 from blocking the
// orchestrator from running itself — it would otherwise scan work-next.js,
// see "fs.writeFileSync" and ".work-state.json" both present, and block.
//
// Use the project's authoritative resolvePluginRoot so we land on
// `<repo>/scripts/` (the plugin root that contains `workflows/work`), NOT
// the entire repo root. Three `..` from `scripts/workflows/work/hooks/`
// → `scripts/`. Resolver falls back to that exact traversal when no env
// var is set, but prefers an env-pinned root when one is present.
const { resolvePluginRoot } = require(path.join(__dirname, '..', 'lib', 'resolve-plugin-root'));
const PLUGIN_ROOT = resolvePluginRoot(__dirname, 3) || path.resolve(__dirname, '..', '..', '..');

const protector = createFileProtector({
  isProtected: isOrchestratorManaged,
  formatMessage,
  trustedScriptRoots: [PLUGIN_ROOT],
});

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let hookData;
  try {
    hookData = JSON.parse(raw);
  } catch {
    process.exit(0); // fail-open on malformed input
  }

  const result = protector.check(hookData.tool_name, hookData.tool_input || {}, hookData);
  if (result && result.blocked) {
    process.stderr.write(result.message);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  try {
    logHookError(__filename, err);
  } catch {
    /* swallow */
  }
  process.exit(0); // fail-open on uncaught error
});
