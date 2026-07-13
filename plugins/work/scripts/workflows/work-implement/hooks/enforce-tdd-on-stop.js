#!/usr/bin/env node

/**
 * SubagentStop hook: Block developer agents from stopping without TDD evidence.
 *
 * Registered in plugins/work/hooks/hooks.json under the `SubagentStop` event
 * (matcher `.*`) — the hook self-filters instead of relying on the matcher.
 *
 * Skip conditions (exit 0, fail-open):
 *   - stop_hook_active set (another stop hook is already running)
 *   - the stopping subagent is not POSITIVELY identified as a developer-*
 *     agent: identification prefers the payload's documented `agent_type`
 *     field (plus legacy agent_name/subagent_type), else falls back to the
 *     structural dispatch-prompt marker in the subagent transcript's first
 *     user message (helpers.transcriptIsDeveloperDispatch). UNIDENTIFIABLE
 *     ⇒ allow — arbitrary subagents (commit-writer, Explore, …) are never
 *     TDD-gated
 *   - ticket id undetectable (WORK_TICKET_ID unset and no cwd/branch signal)
 *   - TASKS_BASE unresolvable / work state unreadable
 *   - active step is not `implement`
 *   - task is a checkpoint type (TDD-exempt)
 *   - TDD evidence is valid for the task's declared `### Type` — via the ONE
 *     shared contract-aware validator (tdd-enforcement.js
 *     validateTddEvidenceForType, the SAME function the implement gate and
 *     the check/complete validators use): TDD-exempt Types (docs/config/ci/
 *     tests-only/mechanical-refactor/file-move) are satisfied by red-only or
 *     green-only evidence (e.g. the gate's non-TDD pre-test stub); TDD-
 *     required Types need a complete RED → GREEN cycle, a recorded
 *     exception, or citation-kind GREEN evidence (`verified-by` /
 *     `wiring-citation` with peerSha)
 *   - no `### Test Strategy` resolution for the task — stop is allowed but
 *     AUDITED: an enforcement row (action `tdd-stop-strategy-missing-allow`)
 *     is appended to .work-actions.json so the bypass is visible. When the
 *     resolver THREW (vs resolving nothing), the row's reason is the distinct
 *     'strategy resolution threw: <msg>' so errors are never mislabeled as
 *     legacy strategy-missing artifacts
 *
 * Block conditions (exit 2):
 *   - runnable Test Strategy resolved but evidence missing/invalid — the hook
 *     NEVER runs tests or records evidence itself (the removed auto-record
 *     path fabricated evidence with WORK_TDD_TOKEN_SKIP=1 and a command that
 *     could differ from task-next's, skipping kind-aware gates); it prints
 *     the ONE next command (task-next.js) and blocks
 *   - citation-kind strategy without valid peer-citation evidence
 *
 * Test Strategy resolution uses the SHARED implement-gate resolver
 * (resolveTaskTestExecution) with the worktree directory resolved from
 * WORK_WORKTREE_DIR / .work-state.json / worktree convention — process.cwd()
 * only as last resort (see helpers.resolveWorktreeDir).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Read stdin (SubagentStop hook data) ────────────────────────────────────
// Prevent infinite loops: if stop_hook_active is set, another stop hook
// is already running — exit immediately to avoid re-entrance.
let _hookData = {};
try {
  const input = fs.readFileSync(0, 'utf-8');
  _hookData = JSON.parse(input);
} catch {
  /* empty/invalid — use default */
}
if (_hookData.stop_hook_active) {
  process.exit(0);
}

// Pure helpers (developer identification, debug-section append, worktree
// resolution, block messages) live in the sibling module to keep this
// entrypoint under the quality budget.
const {
  appendDebugSection,
  resolveWorktreeDir,
  transcriptIsDeveloperDispatch,
  missingEvidenceMessage,
  citationBlockMessage,
} = require(path.join(__dirname, 'enforce-tdd-on-stop-helpers'));

// ─── Self-filter: only POSITIVELY-identified developer-* agents are gated ──
// SubagentStop fires for every subagent (commit-writer, pr-generator, qa-*…).
// Claude Code's documented SubagentStop payload identifies the agent via
// `agent_type` ("present only when the hook fires inside a subagent call");
// legacy `agent_name` / `subagent_type` are read as fallbacks. When no
// payload field is present (older builds), fall back to the subagent
// transcript's first user message: the developer dispatch prompt
// (step-enrichments/implement.js) carries the structural 'self-paced TDD
// agent' + task-next.js markers. UNIDENTIFIABLE ⇒ allow (exit 0): the hook
// must never gate arbitrary subagents — the previous negative filter fell
// through to the evidence check for EVERY payload without an agent name,
// exit-2-blocking code-checker/Explore/commit-writer mid-task.
const _agentName = String(
  _hookData.agent_type || _hookData.agent_name || _hookData.subagent_type || ''
).toLowerCase();
const _isDeveloperAgent = _agentName
  ? /(^|:)developer-/.test(_agentName)
  : transcriptIsDeveloperDispatch(_hookData.transcript_path);
if (!_isDeveloperAgent) {
  process.exit(0);
}

// ─── Detect ticket ID ────────────────────────────────────────────────────────
// Don't rely solely on WORK_TICKET_ID env var — detect from cwd/branch as fallback
let ticketId = process.env.WORK_TICKET_ID;
if (!ticketId) {
  try {
    const { getCurrentTaskId } = require(
      path.join(__dirname, '..', '..', 'lib', 'scripts', 'get-ticket-id')
    );
    ticketId = getCurrentTaskId();
  } catch {
    // Can't detect ticket — will exit below
  }
}

// ─── Debug logger ────────────────────────────────────────────────────────────
function debugLog(message) {
  try {
    const _getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
    const _tasksBase = _getConfig('TASKS_BASE');
    if (!_tasksBase || !ticketId) return;
    let _safeId = ticketId;
    try {
      _safeId = require(path.join(__dirname, '..', '..', 'lib', 'config')).safeTicketId(ticketId);
    } catch {
      _safeId = ticketId.replace(/[/\\:\0]/g, '_');
    }
    const debugPath = path.join(_tasksBase, _safeId, 'debug-tdd-hook.md');
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(debugPath, `${timestamp} | ${message}\n`);
  } catch {
    /* best-effort */
  }
}

if (!ticketId) {
  debugLog('SKIP: no WORK_TICKET_ID');
  process.exit(0);
}

// ─── Resolve paths ───────────────────────────────────────────────────────────

let TASKS_BASE;
try {
  const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
  TASKS_BASE = getConfig('TASKS_BASE');
} catch {
  debugLog('SKIP: no TASKS_BASE (config error)');
  process.exit(0); // can't resolve config — fail-open
}

if (!TASKS_BASE) {
  debugLog('SKIP: no TASKS_BASE');
  process.exit(0);
}

// Sanitize ticket ID for filesystem path
let safeTicket = ticketId;
try {
  const config = require(path.join(__dirname, '..', '..', 'lib', 'config'));
  safeTicket = config.safeTicketId(ticketId);
} catch {
  safeTicket = ticketId.replace(/[/\\:\0]/g, '_');
}

// ─── Get current task number from work state ─────────────────────────────────

let taskNum;
let workState = null;
try {
  const wsPath = path.join(TASKS_BASE, safeTicket, '.work-state.json');
  workState = JSON.parse(fs.readFileSync(wsPath, 'utf8'));

  // Only enforce during implement step
  const currentStep = workState.stepStatus
    ? Object.entries(workState.stepStatus).find(([, v]) => v === 'in_progress')?.[0]
    : null;
  if (currentStep !== 'implement') {
    debugLog('SKIP: step is not implement (step=' + currentStep + ')');
    process.exit(0);
  }

  if (!workState.tasksMeta || !Array.isArray(workState.tasksMeta.tasks)) {
    debugLog('SKIP: no tasksMeta');
    process.exit(0);
  }

  const idx = workState.tasksMeta.currentTaskIndex ?? 0;
  taskNum = Math.min(idx + 1, workState.tasksMeta.tasks.length) || undefined;
} catch {
  debugLog('SKIP: cannot read work state');
  process.exit(0); // can't read state — fail-open
}

if (!taskNum) {
  debugLog('SKIP: no taskNum');
  process.exit(0);
}

// ─── Resolve the task's `### Type` (skip checkpoint tasks) ──────────────────
// The Type drives the SHARED contract-aware evidence validator below. On a
// resolution error, taskType stays null → strict validation (fail closed).

let taskType = null;
try {
  const { resolveTaskType } = require(
    path.join(__dirname, '..', '..', 'work', 'lib', 'resolve-task-type')
  );
  taskType = resolveTaskType(path.join(TASKS_BASE, safeTicket), taskNum);
  if (taskType === 'checkpoint') {
    debugLog('SKIP: checkpoint task');
    process.exit(0);
  }
} catch {
  // Can't resolve task type — continue with the strict TDD check
}

// ─── Check TDD evidence ─────────────────────────────────────────────────────
// validateTddEvidenceForType is the ONE shared validator (same rule the
// implement gate and the check/complete validators apply): TDD-exempt Types
// are satisfied by red-only/green-only evidence (e.g. the gate's non-TDD
// pre-test stub — blocking those with the strict rule wedged exempt tasks at
// SubagentStop); TDD-required Types need a complete RED→GREEN cycle, a
// recorded exception, or citation-kind GREEN evidence with peerSha (GH-509).

let exists = false;
let valid = false;
try {
  const { readTddEvidence, validateTddEvidenceForType } = require(
    path.join(__dirname, '..', '..', 'work', 'lib', 'tdd-enforcement')
  );
  const result = readTddEvidence(TASKS_BASE, safeTicket, 'implement', taskNum);
  exists = result.exists;
  if (exists) {
    valid = validateTddEvidenceForType(result.evidence, taskType).valid;
  }
} catch {
  debugLog('SKIP: evidence check failed');
  process.exit(0); // can't check evidence — fail-open
}

if (exists && valid) {
  debugLog('PASS: evidence valid, allow stop');
  process.exit(0); // evidence valid — allow stop
}

// ─── Resolve the task's Test Strategy (shared resolver) ─────────────────────
// Resolution via the shared implement-gate path (GH-610/GH-653):
//   - an envelope-kind `### Test Strategy` (unit/integration/e2e/custom)
//     resolves to a runnable command → evidence is required, block below;
//   - citation kinds (`verified-by`/`wiring-citation`) resolve to NO command by
//     design — satisfied by peer-citation green evidence checked above; when
//     that evidence is missing, block with the citation instruction;
//   - a task with no strategy resolves to source:null → audited allow below.
// Fail-open: any error here (resolver threw, module failed to load) leaves
// resolution null and falls through to the audited allow — but the error is
// captured so the audit row carries a DISTINCT reason ('strategy resolution
// threw: …') instead of mislabeling agent-induced resolution failures as a
// legacy strategy-missing artifact (bypass review, W1 follow-up).
const tasksDir = path.join(TASKS_BASE, safeTicket);
let testCommand = null;
let isStrategyResolution = false;
let resolutionError = null;
try {
  const { resolveTaskTestExecution } = require(
    path.join(__dirname, '..', '..', 'work', 'lib', 'step-enrichments', 'implement-gate')
  );
  const worktreeDir = resolveWorktreeDir(workState, safeTicket);
  const resolved = resolveTaskTestExecution(tasksDir, taskNum, worktreeDir);
  testCommand = resolved.command || null;
  isStrategyResolution = resolved.source === 'strategy';
} catch (err) {
  resolutionError = String((err && err.message) || err).slice(0, 300);
}

// ─── Runnable strategy without valid evidence — block (never auto-record) ───
if (testCommand) {
  debugLog('BLOCK: evidence missing/invalid for task ' + taskNum + ' (runnable strategy)');
  process.stderr.write(missingEvidenceMessage(safeTicket, taskNum));
  process.exit(2);
}

// ─── Citation-kind strategy with no valid evidence — block (do NOT bypass) ───
// A citation-kind `### Test Strategy` (verified-by / wiring-citation) resolves
// to NO runnable command by design, but it is NOT a task "without tests": its
// evidence is a peer-citation green entry recorded via tdd-phase-state.js.
if (isStrategyResolution && !testCommand) {
  debugLog('BLOCK: citation-kind strategy without valid evidence');
  process.stderr.write(citationBlockMessage(safeTicket, taskNum));
  process.exit(2);
}

// ─── No Test Strategy resolution — allow stop, but AUDIT the bypass ─────────
// Gate-driven TDD requires a `### Test Strategy` block in tasks.md; the
// draft/tasks_gate validators reject task documents without one, so reaching
// here means a legacy or broken artifact. Allow the agent to stop, but append
// a visible enforcement audit row to .work-actions.json (not just debug.md).

// A resolver ERROR is not the same artifact as a missing strategy: the audit
// row names it distinctly so operators can tell an agent-induced resolution
// failure (broken custom strategy, corrupted worktree) from a legacy task
// that never declared a `### Test Strategy`.
const bypassReason = resolutionError
  ? 'strategy resolution threw: ' +
    resolutionError +
    ' — subagent stop allowed without TDD evidence (task ' +
    taskNum +
    ')'
  : 'no ### Test Strategy resolution for task ' +
    taskNum +
    ' — subagent stop allowed without TDD evidence';

try {
  const { appendEnforcementAuditAt } = require(
    path.join(__dirname, '..', '..', 'work', 'lib', 'work-actions')
  );
  appendEnforcementAuditAt(TASKS_BASE, safeTicket, {
    origin: 'workflow',
    task: taskNum,
    phase: null,
    action: 'tdd-stop-strategy-missing-allow',
    allow: true,
    reason: bypassReason,
    outputPath: null,
  });
} catch {
  // Audit is fail-open: never block the stop because logging failed.
}

appendDebugSection(
  TASKS_BASE,
  safeTicket,
  `- **[BYPASS]** task ${taskNum}: ${
    resolutionError
      ? `strategy resolution threw: ${resolutionError}`
      : 'no ### Test Strategy resolution'
  } — evidence check skipped (audited)`
);

debugLog(
  resolutionError
    ? 'BYPASS: strategy resolution threw (audited allow)'
    : 'BYPASS: no Test Strategy resolution for task (audited allow)'
);
process.exit(0);
