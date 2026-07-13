/**
 * Step: 5_phase1_agents — Launch code-checker and completion-checker in parallel.
 * Tests are already handled by 4_run_tests (deterministic script).
 *
 * Uses the same delegates pattern as implement step for clarity.
 * Returns a parallel instruction with exact prompts per agent.
 * On subsequent calls, checks if reports exist and auto-advances.
 *
 * Race hardening (GH-611, GH-343):
 * - A 0-byte report counts as MISSING (clobber-race victim), and is surfaced
 *   distinctly ("truncated/empty") from a never-written report.
 * - Per-report completion is STICKY in state (state.phase1Reports): once a
 *   report has been observed present + non-empty for this dispatch, a later
 *   purge/clobber can no longer deadlock the step — we don't require both
 *   files to coexist at one instant.
 * - Re-dispatch is TARGETED: only the agent(s) whose report is still missing
 *   are re-launched, and each report gets at most MAX_DISPATCH_ATTEMPTS
 *   dispatches. After that the step blocks with an actionable error naming
 *   the missing artifact instead of silently re-dispatching forever.
 *
 * HEAD-staleness validation (GH-308):
 * - Phase-1 agents run in parallel; one agent's mid-run fix commit makes a
 *   sibling's findings describe pre-fix code. Each report must therefore
 *   carry a canonical `**Head:** <sha>` line (the worktree HEAD the agent
 *   verified against). At collection time a FAILING report whose Head no
 *   longer matches the current worktree HEAD is treated as STALE and its
 *   agent re-dispatched — reusing the same sticky tracker + attempts cap as
 *   missing-report retries (no second retry mechanism).
 * - PASS reports are never invalidated by HEAD movement (fixes only move
 *   code forward — re-verifying a pass would only churn).
 * - Reports without a Head line (legacy agents, manual writes) are treated
 *   as current-HEAD (backward compatible, no re-dispatch storm).
 * - When the attempts cap is hit, the stale report is accepted as-is with a
 *   visible `## Workflow Note` appended, instead of looping.
 */

'use strict';

// Registry-derived 'N/M' progress label. Lazy require: the registry requires
// this module at load time, so a top-level require back would see a partial
// module through the cycle (PR #669 review — stale hardcoded counts).
function stepProgress(name) {
  return require('../step-registry').stepProgress(name);
}

const fs = require('fs');
const path = require('path');
const { reportStatus } = require('../report-utils');
// GH-308 HEAD-staleness helpers live in ../report-head-staleness (extracted
// verbatim for the file-size budget — see that module's doc comment).
const {
  HEAD_LINE_RE,
  currentWorktreeHead,
  reportIsStale,
  annotateStaleAccepted,
} = require('../report-head-staleness');
const { T, getRuntime } = require('../../../lib/instruction-vocab');

// Max times we ask the orchestrator to (re-)dispatch an agent for the same
// missing/empty report before blocking with an actionable error.
const MAX_DISPATCH_ATTEMPTS = 3;

const REPORTS = [
  { file: 'code-review.check.md', agent: 'work-workflow:code-checker', statusType: 'codeReview' },
  {
    file: 'completion.check.md',
    agent: 'work-workflow:completion-checker',
    statusType: 'completion',
  },
];

// Shared contract appended to every phase-1 agent prompt (GH-343: agents that
// only give a chat verdict, or background-write failures, stall the step).
function reportContractLines(reportPath, dispatchHead) {
  return [
    '',
    '### Report contract (MANDATORY — the orchestrator only reads the file)',
    '',
    `- Your verdict MUST be written to \`${reportPath}\` — a chat-only summary does NOT count and stalls the workflow.`,
    '- The report MUST start with the canonical machine-readable line `**Status:** APPROVED` (code review) / `**Status:** COMPLETE` (completion) — or `**Status:** NEEDS_WORK` when failing. Gates parse this line FIRST; prose-only verdicts parse as UNKNOWN and loop the check step.',
    `- Directly under the Status line, write the canonical line \`**Head:** <sha>\` with the ticket worktree's \`git rev-parse HEAD\` at the moment you VERIFIED the code (GH-308${
      dispatchHead ? `; HEAD at dispatch was ${dispatchHead}` : ''
    }). Sibling agents may commit fixes while you review — the orchestrator compares your Head to the live HEAD and re-dispatches a FAILING report anchored to an older commit, so re-check HEAD right before writing the report and re-verify your findings if it moved.`,
    '- Create/update the report with the **Write tool** (not bash heredocs — they have silently failed before).',
    `- If the runner blocks and you cannot drive it to DONE, still write \`${reportPath}\` yourself with your verdict plus a \`## Workflow Note\` section describing the blocker.`,
    `- Before finishing, VERIFY the file exists and is non-empty (e.g. \`ls -l ${reportPath}\`). If it is missing or 0 bytes, write it again.`,
    '- Freshness (echo-5352): re-verify every cited file:line against the CURRENT working tree (fresh Read/grep — never from memory of a previous run), and end the report with the footer line `Verified at <changes-hash>` using the Changes hash above.',
  ];
}

// Mark tasks as verified [v] when the completion report says COMPLETE.
// Runs the moment the completion report is first observed (before any later
// clobber can eat it). Fail-open.
function markVerifiedFromCompletion(completionPath, ctx) {
  try {
    const completionReport = fs.readFileSync(completionPath, 'utf8');
    const { hasVerdict } = require(
      path.join(__dirname, '..', '..', '..', 'lib', 'parse-completion-status')
    );
    if (hasVerdict(completionReport, ['COMPLETE'])) {
      const { markVerified } = require(
        path.join(__dirname, '..', '..', '..', 'work', 'lib', 'mark-task-progress')
      );
      markVerified(ctx.tasksDir);
    }
  } catch {
    /* fail-open */
  }
}

/**
 * Scan report files and update the sticky per-report tracker in state.
 * A present report is only accepted when it is not HEAD-stale (GH-308):
 * a FAILING report whose `**Head:**` sha no longer matches `currentHead`
 * re-enters the missing list (status 'stale') for a targeted re-dispatch —
 * unless its attempts cap is exhausted, in which case it is accepted as-is
 * with a visible annotation.
 * Returns { done: string[], missing: [{file, status, reportHead?}] }.
 */
function scanReports(state, reportFolder, ctx, currentHead) {
  if (!state.phase1Reports) state.phase1Reports = {};
  const done = [];
  const missing = [];
  for (const report of REPORTS) {
    const miss = scanOneReport(state, reportFolder, ctx, currentHead, report);
    if (miss) missing.push(miss);
    if (state.phase1Reports[report.file].done) done.push(report.file);
  }
  return { done, missing };
}

// Scan a single report file, updating its sticky tracker. Returns a missing
// entry ({file, status, ...}) when the report still needs a dispatch, or null
// once the tracker is (or becomes) done.
function scanOneReport(state, reportFolder, ctx, currentHead, { file, statusType }) {
  const tracker = state.phase1Reports[file] || (state.phase1Reports[file] = { attempts: 0 });
  if (tracker.done) return null;
  const reportPath = path.join(reportFolder, file);
  const status = reportStatus(reportPath);
  if (status !== 'present') return { file, status };
  const miss = evaluatePresentReport(tracker, reportPath, statusType, currentHead);
  if (tracker.done && file === 'completion.check.md') {
    markVerifiedFromCompletion(reportPath, ctx);
  }
  return miss ? { file, ...miss } : null;
}

// A present report is only accepted when it is not HEAD-stale (GH-308): a
// FAILING report whose `**Head:**` sha no longer matches `currentHead` yields
// a {status: 'stale', ...} missing entry for a targeted re-dispatch — unless
// its attempts cap is exhausted, in which case it is accepted as-is with a
// visible annotation.
function evaluatePresentReport(tracker, reportPath, statusType, currentHead) {
  let content = '';
  try {
    content = fs.readFileSync(reportPath, 'utf8');
  } catch {
    /* raced away — fall through, content stays '' (not stale) */
  }
  const headMatch = content.match(HEAD_LINE_RE);
  if (reportIsStale(content, statusType, currentHead)) {
    if (tracker.attempts < MAX_DISPATCH_ATTEMPTS) {
      return { status: 'stale', reportHead: headMatch[1], currentHead };
    }
    // Cap hit: surface the stale report as-is with a clear note instead of
    // looping (GH-308).
    annotateStaleAccepted(reportPath, headMatch[1], currentHead, MAX_DISPATCH_ATTEMPTS);
    tracker.staleAccepted = { reportHead: headMatch[1], currentHead };
  }
  tracker.done = true;
  tracker.seenAt = new Date().toISOString();
  return null;
}

// Build structured verification context from planning artifacts (best-effort).
function loadCompletionContext(ctx, state) {
  try {
    const { buildCompletionContext } = require(
      path.join(__dirname, '..', 'step-enrichments', 'completion-context')
    );
    return buildCompletionContext(ctx.tasksDir, state.ticketId);
  } catch {
    return '(Could not load planning artifacts — verify against PR diff only)';
  }
}

function buildCodeReviewDelegate(state, changesHash, codeReviewReport, dispatchHead) {
  return {
    type: 'task',
    agentType: 'work-workflow:code-checker',
    description: `Code review — ${state.ticketId}`,
    prompt: [
      `## Code Review for ${state.ticketId}`,
      '',
      '### MANDATORY: self-paced runner',
      '',
      `Drive the review through the code-next.js runner. It phases inputs → change_classify → file_coverage → standards_audit → kind_checks → report → memorize → done and writes your verdict into ${codeReviewReport}.`,
      '',
      '```',
      `node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-code-checker/code-next.js ${state.ticketId}`,
      '```',
      '',
      "Follow the runner output verbatim. Re-invoke after performing each phase's action — stop only when it prints `NEXT_ACTION: DONE`.",
      '',
      `Changes hash: ${changesHash}`,
      '',
      '### What to check',
      '- Bugs, logic errors, security vulnerabilities',
      '- Code quality, naming, patterns adherence',
      '- Missing error handling at system boundaries',
      '',
      '### Rules',
      '- Do NOT run tests (already handled by deterministic script)',
      '- Do NOT modify any code — only review and report',
      '- Verify your recommendations (echo-5213): any recommended fix that changes types, function signatures, or schemas MUST be verified compilable — run the project typecheck (e.g. `$TYPECHECK_COMMAND` / `tsc --noEmit`) scoped to the touched file with the fix applied in a scratch copy (never leave working-tree modifications behind). If you cannot verify it, mark the recommendation `UNVERIFIED` in the report — an unverified "fix" that breaks 14 call sites costs more dev cycles than no recommendation.',
      ...reportContractLines(codeReviewReport, dispatchHead),
    ].join('\n'),
    // Vocab token: claude byte-identical, codex says "execute inline" (C1).
    note: T('delegate.task.note.short', {}, getRuntime().name),
  };
}

function buildCompletionDelegate(
  state,
  changesHash,
  completionReport,
  completionContext,
  dispatchHead
) {
  return {
    type: 'task',
    agentType: 'work-workflow:completion-checker',
    description: `Verify requirements — ${state.ticketId}`,
    prompt: [
      `## Verify ALL requirements for ${state.ticketId}`,
      '',
      '### MANDATORY: self-paced runner',
      '',
      `Drive verification through the completion-next.js runner. It phases inputs → requirements_extract → diff_scope → coverage_check → kind_checks → report → memorize → done and writes your verdict into ${completionReport}.`,
      '',
      '```',
      `node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-completion-checker/completion-next.js ${state.ticketId}`,
      '```',
      '',
      "Follow the runner output verbatim. Re-invoke after performing each phase's action — stop only when it prints `NEXT_ACTION: DONE`.",
      '',
      `Changes hash: ${changesHash}`,
      '',
      '# Verification Context (pre-loaded from planning artifacts)',
      '',
      completionContext,
      '',
      '# Instructions',
      '',
      'Verify each layer in order (ticket → brief → spec → tasks).',
      'For EACH requirement/deliverable: grep or read the actual code to find evidence.',
      'Mark DELIVERED only with a code citation (file:line or diff excerpt).',
      'Mark INCOMPLETE if any P0 requirement lacks code evidence.',
      ...reportContractLines(completionReport, dispatchHead),
    ].join('\n'),
    // Vocab token: claude byte-identical, codex says "execute inline" (C1).
    note: T('delegate.task.note.short', {}, getRuntime().name),
  };
}

function buildDelegate(file, state, ctx, reportFolder, changesHash, dispatchHead) {
  const reportPath = path.join(reportFolder, file);
  if (file === 'code-review.check.md') {
    return buildCodeReviewDelegate(state, changesHash, reportPath, dispatchHead);
  }
  return buildCompletionDelegate(
    state,
    changesHash,
    reportPath,
    loadCompletionContext(ctx, state),
    dispatchHead
  );
}

// Human-readable description of why a report is missing (GH-343: distinguish
// "agent finished but the file was never created" from "file was truncated").
function describeMissing(m, reportFolder) {
  const full = path.join(reportFolder, m.file);
  if (m.status === 'stale') {
    return (
      `${full} is HEAD-STALE — its failing verdict was verified at Head ${m.reportHead} but the ` +
      `worktree HEAD has since moved to ${m.currentHead} (a sibling agent committed fixes ` +
      `mid-review, GH-308); its findings may already be fixed. Re-verify against the CURRENT code`
    );
  }
  return m.status === 'empty'
    ? `${full} exists but is EMPTY (0 bytes — truncated by a write race; the agent likely finished but its report was clobbered)`
    : `${full} was never created (the agent completed without writing its report file)`;
}

module.exports = function registerPhase1(register) {
  register('5_phase1_agents', (state, ctx) => {
    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const changesHash = state.changesHash || 'unknown';

    // Ticket-worktree HEAD at this scan/dispatch (GH-308). Null → staleness
    // validation is skipped (fail-open) but dispatch still proceeds.
    const currentHead = currentWorktreeHead(state, ctx);

    const { missing } = scanReports(state, reportFolder, ctx, currentHead);

    // All reports observed (sticky) → advance.
    if (missing.length === 0) return null;

    const alreadyDispatched = state.dispatched === '5_phase1_agents';

    // Cap re-dispatches per report: stop with an actionable error instead of
    // silently re-dispatching forever (GH-611).
    if (alreadyDispatched) {
      const exhausted = missing.filter(
        (m) => state.phase1Reports[m.file].attempts >= MAX_DISPATCH_ATTEMPTS
      );
      if (exhausted.length > 0) {
        return {
          type: 'check_instruction',
          action: 'blocked',
          state: {
            ticket: state.ticketId,
            currentStep: '5_phase1_agents',
            progress: stepProgress('5_phase1_agents'),
          },
          reason:
            `Phase-1 agent(s) completed but their report is still missing after ` +
            `${MAX_DISPATCH_ATTEMPTS} dispatch attempts:\n` +
            exhausted.map((m) => `- ${describeMissing(m, reportFolder)}`).join('\n') +
            `\nDo NOT re-dispatch. Recover the verdict from the agent transcript and write the ` +
            `report yourself with the Write tool (include the Changes hash ${changesHash}), ` +
            `then re-run check-next.js.`,
        };
      }
    }

    // Dispatch (first time: all reports; retries: ONLY the missing/stale ones).
    state.dispatched = '5_phase1_agents';
    state.phase1HeadAtDispatch = currentHead; // observability (GH-308)
    const delegates = [];
    for (const m of missing) {
      state.phase1Reports[m.file].attempts += 1;
      delegates.push(buildDelegate(m.file, state, ctx, reportFolder, changesHash, currentHead));
    }

    const retryNote = alreadyDispatched
      ? ` This is a TARGETED RETRY (attempt ${Math.max(
          ...missing.map((m) => state.phase1Reports[m.file].attempts)
        )}/${MAX_DISPATCH_ATTEMPTS}) — previous dispatch finished but: ${missing
          .map((m) => describeMissing(m, reportFolder))
          .join('; ')}.`
      : '';

    return {
      type: 'check_instruction',
      action: 'execute',
      state: {
        ticket: state.ticketId,
        currentStep: '5_phase1_agents',
        progress: stepProgress('5_phase1_agents'),
      },
      continue: true,
      parallel: delegates.length > 1,
      delegates,
      note: buildLaunchNote(delegates.length, retryNote, getRuntime()),
    };
  });
};

// Per-runtime launch note. The claude branch is byte-identical to the
// historical literal (characterization-pinned); codex has no Task tool nor
// run_in_background, so parallel dispatch is serialized inline (C1).
function buildLaunchNote(count, retryNote, rt) {
  if (rt.name === 'codex') {
    return (
      `[work:codex-degraded] parallel dispatch serialized — execute EXACTLY these ${count} ` +
      `task prompt(s) INLINE, one after another (no Task tool on codex). Do NOT add any ` +
      `other agents — tests are handled by a deterministic script.` +
      retryNote
    );
  }
  return (
    `Launch EXACTLY these ${count} agent(s)` +
    (count > 1 ? ' IN PARALLEL (single message, one Task tool call each)' : '') +
    `. Launch them in the FOREGROUND (never run_in_background — background agent writes have ` +
    `silently disappeared, GH-343). Do NOT add any other agents — tests are handled by a ` +
    `deterministic script.` +
    retryNote
  );
}

module.exports.MAX_DISPATCH_ATTEMPTS = MAX_DISPATCH_ATTEMPTS;
module.exports.REPORTS = REPORTS;
module.exports.HEAD_LINE_RE = HEAD_LINE_RE;
