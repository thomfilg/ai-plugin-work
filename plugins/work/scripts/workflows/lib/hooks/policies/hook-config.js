/**
 * policies/hook-config.js
 *
 * Static configuration for enforce-step-workflow.js, extracted so the hook
 * entry stays under the quality gate's max-lines cap:
 *
 *   - EXEMPT_SCRIPTS: legitimate state-file writers exempt from Vector 3
 *   - SAFE_SUBCOMMANDS: read-only/idempotent sub-commands per state script
 *   - CHECK_AGENTS: /check agents that bypass /work step blocking
 *   - TRUSTED_SCRIPT_DIRS: directories where exempt scripts may live,
 *     realpath-normalised at module load (GH-452)
 *   - debugLogCandidatePath / debugLogTrustedDirs: GH-452 diagnostics
 *
 * All paths are computed relative to the hooks directory (one level up),
 * preserving the exact directory set the hook used when this lived inline.
 */

const fs = require('fs');
const path = require('path');

// The hooks directory — enforce-step-workflow.js's __dirname before extraction.
const HOOKS_DIR = path.resolve(__dirname, '..');

// Exempt orchestrator and workflow-engine scripts from Vector 3 (script bypass detection)
// These are the legitimate writers of state files.
const EXEMPT_SCRIPTS = new Set([
  'work.workflow.js',
  'workflow-engine.js',
  'work-state.js',
  'workflow-state.js',
  'session-guard.js',
  'check-next.js',
  'follow-up-next.js',
  'follow-up-pr-comments.js',
  'work-next.js',
  // Orchestrator-side health monitor: read-only on state files, writes
  // throttle markers to /tmp only. Mentions .work-state.json in source
  // (for the path argument) which trips Vector 3 — exempt here.
  'workflow-monitor.js',
]);

// Sub-command filtering for state scripts (GH-89).
// work-state.js: exempt for get, resume-info, init, active-subtask, add-error.
// workflow-state.js: exempt for get, resume-info, add-error (init blocked — not idempotent).
// Mutating sub-commands (set-step, set-check, complete, etc.) must go through the orchestrator.
// Exception: 'complete' is step-conditionally allowed at the terminal step via strict match (GH-276).
const SAFE_SUBCOMMANDS = {
  'work-state.js': new Set([
    'get',
    'resume-info',
    'init',
    'active-subtask',
    'add-error',
    'task-init',
    'task-current',
    // 'task-advance' removed (GH-695): advanceTask blind-marks the current
    // task completed. Its legitimate callers are driver-internal execFileSync
    // spawns (advance-gate.js, next-instruction.js, task-next.js) that never
    // traverse PreToolUse — a Bash call is never legitimate. exemptPatterns
    // in workflows/work/workflow-definition.js is kept aligned.
    'task-get',
  ]),
  'workflow-state.js': new Set(['get', 'resume-info', 'add-error']), // init excluded: not idempotent (resets all steps). exemptPatterns aligned.
  'session-guard.js': new Set(['init', 'status']), // SAFE_SUBCOMMANDS session-guard (GH-338)
};

// Agents legitimately used by /check that should bypass /work step blocking
const CHECK_AGENTS = new Set([
  'quality-checker',
  'work-workflow:quality-checker',
  'code-checker',
  'work-workflow:code-checker',
  'completion-checker',
  'work-workflow:completion-checker',
  'qa-feature-tester',
  'work-workflow:qa-feature-tester',
  'qa-api-tester',
  'work-workflow:qa-api-tester',
]);

// Trusted directories where exempt scripts are allowed to live.
// Only scripts resolved under these paths are exempt — prevents basename spoofing.
const TRUSTED_SCRIPT_DIRS = [
  path.resolve(HOOKS_DIR), // workflows/lib/hooks/
  path.resolve(HOOKS_DIR, '..'), // workflows/lib/
  path.resolve(HOOKS_DIR, '..', 'scripts'), // workflows/lib/scripts/
  path.resolve(HOOKS_DIR, '..', '..', 'work'), // workflows/work/
  path.resolve(HOOKS_DIR, '..', '..', 'work', 'scripts'), // workflows/work/scripts/
  path.resolve(HOOKS_DIR, '..', '..', 'check', 'scripts'), // workflows/check/scripts/
  path.resolve(HOOKS_DIR, '..', '..', 'work-implement'), // workflows/work-implement/
  path.resolve(HOOKS_DIR, '..', '..', 'work-brief'), // workflows/work-brief/
  path.resolve(HOOKS_DIR, '..', '..', 'work-spec'), // workflows/work-spec/
  path.resolve(HOOKS_DIR, '..', '..', 'work-tasks'), // workflows/work-tasks/
  path.resolve(HOOKS_DIR, '..', '..', 'work-pr-step'), // workflows/work-pr-step/
  path.resolve(HOOKS_DIR, '..', '..', 'work-ci'), // workflows/work-ci/
  path.resolve(HOOKS_DIR, '..', '..', 'work-completion-checker'), // workflows/work-completion-checker/
  path.resolve(HOOKS_DIR, '..', '..', 'work-code-checker'), // workflows/work-code-checker/
  path.resolve(HOOKS_DIR, '..', '..', 'work-qa-feature-tester'), // workflows/work-qa-feature-tester/
  path.resolve(HOOKS_DIR, '..', '..', 'work-pr-reviewer'), // workflows/work-pr-reviewer/
  path.resolve(HOOKS_DIR, '..', '..', 'work-task-review'), // workflows/work-task-review/
  path.resolve(HOOKS_DIR, '..', '..', 'work-reports'), // workflows/work-reports/
  path.resolve(HOOKS_DIR, '..', '..', 'work-cleanup'), // workflows/work-cleanup/
  path.resolve(HOOKS_DIR, '..', '..', 'work'), // workflows/work/
  path.resolve(HOOKS_DIR, '..', '..', 'check'), // workflows/check/
  path.resolve(HOOKS_DIR, '..', '..', 'follow-up'), // workflows/follow-up/
];

// GH-452: Normalise TRUSTED_SCRIPT_DIRS via fs.realpathSync at module load so the
// prefix containment check does not depend on per-call realpath resolution
// against a possibly-symlinked plugin-cache directory. Membership is NOT
// widened — the same set of directories is normalised in place. Per-entry
// realpath failure is fail-open (keep the unresolved path so
// isTrustedScriptPath defence-in-depth per-call realpath retains today's
// behaviour) and emits a `GH-452 trusted-dir realpath failed` warning on
// stderr.
function safeRealpath(entry) {
  try {
    return fs.realpathSync(entry);
  } catch (err) {
    process.stderr.write(
      `GH-452 trusted-dir realpath failed: ${entry} (${err && err.code ? err.code : 'EUNKNOWN'})\n`
    );
    return entry;
  }
}
for (let i = 0; i < TRUSTED_SCRIPT_DIRS.length; i++) {
  TRUSTED_SCRIPT_DIRS[i] = safeRealpath(TRUSTED_SCRIPT_DIRS[i]);
}

// GH-452: Diagnostic instrumentation gated behind ENFORCE_HOOK_DEBUG=1.
// Dumps the hooks dir and each TRUSTED_SCRIPT_DIRS entry alongside its realpath
// at module load, plus a per-call candidate=<path> realpath=<resolved> line
// inside the authorization decision path. Used to classify CI failure modes
// (resolve drift, symlink skew, race) without altering trust semantics.
// Absolute paths only — no secrets. See GH-452.
function debugLogTrustedDirs() {
  if (process.env.ENFORCE_HOOK_DEBUG !== '1') return;
  process.stderr.write(`GH-452 __dirname=${HOOKS_DIR}\n`);
  for (const dir of TRUSTED_SCRIPT_DIRS) {
    let realpath;
    try {
      realpath = fs.realpathSync(dir);
    } catch (err) {
      realpath = `<realpath-error: ${err && err.code ? err.code : 'EUNKNOWN'}>`;
    }
    process.stderr.write(`GH-452 trusted-dir entry=${dir} realpath=${realpath}\n`);
  }
}
function debugLogCandidatePath(candidate) {
  if (process.env.ENFORCE_HOOK_DEBUG !== '1') return;
  let realpath;
  try {
    realpath = fs.realpathSync(path.resolve(candidate));
  } catch (err) {
    realpath = `<realpath-error: ${err && err.code ? err.code : 'EUNKNOWN'}>`;
  }
  process.stderr.write(`GH-452 candidate=${candidate} realpath=${realpath}\n`);
}
debugLogTrustedDirs();

module.exports = {
  EXEMPT_SCRIPTS, // legitimate state-file writers (Vector 3 exempt)
  SAFE_SUBCOMMANDS, // read-only/idempotent sub-commands per state script
  CHECK_AGENTS, // /check agents that bypass /work step blocking
  TRUSTED_SCRIPT_DIRS, // realpath-normalised trusted directories (GH-452)
  debugLogCandidatePath, // GH-452 per-call diagnostic
};
