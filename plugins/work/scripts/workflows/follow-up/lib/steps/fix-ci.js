/**
 * Step: fix-ci — Fix CI failures or merge conflicts.
 *
 * Fetches the actual failed CI logs via `gh run view --log-failed`
 * and passes them to the developer agent so it knows EXACTLY what broke.
 */

'use strict';

const { execFileSync } = require('child_process');
const { buildChildEnv } = require('../../../work/scripts/gh-exec');
const { filterLogs } = require('../log-utils');
const { T, getRuntime } = require('../../../lib/instruction-vocab');

function shellSafe(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pushGhErr(errors, stage, err) {
  const msg = shellSafe(err?.stderr || err?.stdout || err?.message || 'unknown');
  errors.push(`[${stage}] ${msg.substring(0, 300)}`);
}

// NOTE: gh's `--job` flag requires a numeric job ID (not a name). We don't have
// job IDs here — only check-run names — so we run `--log-failed` for the entire
// run. That already filters to failing steps; our filterLogs() strips the rest.
function fetchRunLogs(runId, ctx, errors) {
  try {
    return execFileSync('gh', ['run', 'view', String(runId), '--log-failed'], {
      encoding: 'utf8',
      timeout: 30000,
      cwd: ctx.worktreeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      env: buildChildEnv(),
    });
  } catch (err) {
    pushGhErr(errors, `run-view ${runId}`, err);
    return '';
  }
}

function parseCheckLine(line) {
  const [name, link] = line.split('\t');
  const m = String(link || '').match(/runs\/(\d+)/);
  return name && m ? { name: name.trim(), runId: m[1] } : null;
}

// Strategy 2 (fallback): re-query `gh pr checks` for failed jobs + links.
function queryPrChecksTargets(prNum, ctx, errors) {
  const targets = [];
  let linksOutput;
  try {
    linksOutput = execFileSync(
      'gh',
      [
        'pr',
        'checks',
        String(prNum),
        '--json',
        'name,state,link',
        '--jq',
        '.[] | select(.state == "FAILURE") | "\(.name)\t\(.link)"',
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        cwd: ctx.worktreeDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildChildEnv(),
      }
    );
  } catch (err) {
    pushGhErr(errors, 'pr-checks', err);
    return targets;
  }
  for (const line of linksOutput.split('\n').filter(Boolean)) {
    const t = parseCheckLine(line);
    if (t) targets.push(t);
  }
  return targets;
}

// Strategy 1 (preferred): use the structured failed-job list captured by
// monitor.js — exact job names + runIds derived from the check `link`. Falls
// back to strategy 2 when monitor reported nothing.
function collectFailedTargets(prNum, ctx, failedJobs, errors) {
  const targets = [];
  for (const j of failedJobs) {
    if (j && j.name && j.runId) targets.push({ name: j.name, runId: j.runId });
  }
  if (targets.length > 0) return targets;
  return queryPrChecksTargets(prNum, ctx, errors);
}

// Fetch logs only for the actually-failed jobs (up to 3 distinct runIds).
function fetchRunLogChunks(targets, ctx, errors) {
  const seenRuns = new Set();
  const chunks = [];
  for (const t of targets) {
    if (seenRuns.has(t.runId)) continue;
    seenRuns.add(t.runId);
    const raw = fetchRunLogs(t.runId, ctx, errors);
    if (raw) chunks.push(`### Failed job: ${t.name}\n` + filterLogs(raw));
    if (chunks.join('\n').length > 8000) break;
    if (seenRuns.size >= 3) break;
  }
  return chunks;
}

function buildNoLogsMessage(targets, errors) {
  const errLines = errors.length
    ? errors.map((e) => `  - ${e}`).join('\n')
    : '  - no failed jobs reported by monitor or gh pr checks';
  const jobsHint = targets.length
    ? '\nFailed jobs (from monitor): ' + targets.map((t) => t.name).join(', ')
    : '';
  return '(Could not fetch CI logs automatically)\nCommands attempted:\n' + errLines + jobsHint;
}

// Fetch the actual failed-run logs. Strategy:
//   1. Use monitor.js's structured failed-job list (exact names + runIds).
//   2. Fall back to `gh pr checks --json` for FAILURE links.
//   3. For each candidate run, fetch `--log-failed`, filtered to test/assert
//      lines, truncated to fit the prompt budget.
//   4. Surface real fetch errors instead of swallowing them.
function fetchCiLogs(prNum, ctx, failedJobs) {
  const errors = [];
  const targets = collectFailedTargets(prNum, ctx, failedJobs, errors);
  const chunks = fetchRunLogChunks(targets, ctx, errors);
  if (chunks.length > 0) return chunks.join('\n\n').substring(0, 8000);
  return buildNoLogsMessage(targets, errors);
}

// ── HARD STOP on merge conflict ───────────────────────────────────────────
// Conflicts are NOT auto-resolved. Halt the workflow and tell the agent (and
// the user) to sync the branch before continuing. This prevents auto-rebase
// delegates from silently dropping upstream changes that need human judgement
// (big sibling-PR merges, conflicting schema migrations, etc).
function buildConflictBlocked(state) {
  const prNum = state.prNumber || 'unknown';
  const files = Array.isArray(state._mergeStatus && state._mergeStatus.localConflictFiles)
    ? state._mergeStatus.localConflictFiles
    : [];
  const baseBranch = state._mergeStatus && state._mergeStatus.baseBranch;
  const fileSuffix = files.length
    ? ` Conflicting file${files.length > 1 ? 's' : ''}: ${files.join(', ')}.`
    : '';
  const baseSuffix = baseBranch ? ` (target: ${baseBranch})` : '';
  return {
    type: 'follow_up_instruction',
    action: 'blocked',
    reason: `Merge conflicts found on PR #${prNum}${baseSuffix} — resolve them manually:${fileSuffix} (1) sync your branch with the target branch, which exposes the conflicts; (2) resolve the conflicts in the listed files; (3) push the resolution; (4) re-run /follow-up ${state.ticketId || ''}.`,
    state: { ticket: state.ticketId, currentStep: 'fix-ci', attempt: state.attempt || 0 },
  };
}

function buildConflictPrompt(prNum, monitorOutput) {
  return [
    `## Merge Conflict on PR #${prNum}`,
    '',
    '### Monitor output:',
    '```',
    monitorOutput,
    '```',
    '',
    '### Instructions:',
    '1. Resolve the merge conflict',
    '2. Run tests locally: `pnpm test`',
    '3. Commit the resolution',
    '4. Do NOT push',
  ].join('\n');
}

function buildCiFailurePrompt(prNum, ciStatusLine, ciStatusDetail, ciLogs) {
  return [
    `## CI Failure on PR #${prNum}`,
    '',
    ...(ciStatusLine ? [ciStatusLine] : []),
    ...(ciStatusDetail ? [ciStatusDetail] : []),
    '',
    '### Failed CI logs:',
    '```',
    ciLogs || '(no logs captured)',
    '```',
    '',
    '### Instructions:',
    '1. Read the error above — the root cause is in the logs',
    '2. Fix the failing code',
    '3. Run tests locally to verify: `pnpm test`',
    '4. Commit the fix',
    '5. Do NOT push',
  ].join('\n');
}

function buildExecuteInstruction(state, prNum, isConflict, monitorOutput, ciLogs) {
  const ciStatusLine = state._ciStatusLine || '';
  const ciStatusDetail = state._ciStatusDetail || '';
  return {
    type: 'follow_up_instruction',
    action: 'execute',
    state: { ticket: state.ticketId, currentStep: 'fix-ci', attempt: state.attempt },
    continue: true,
    delegate: {
      type: 'task',
      agentType: 'work-workflow:developer-nodejs-tdd',
      description: `Fix ${isConflict ? 'merge conflict' : 'CI failure'} on PR #${prNum} (attempt ${state.attempt})`,
      prompt: isConflict
        ? buildConflictPrompt(prNum, monitorOutput)
        : buildCiFailurePrompt(prNum, ciStatusLine, ciStatusDetail, ciLogs),
      // Vocab token: claude byte-identical, codex says "execute inline" (C1).
      note: T('delegate.task.note.short', {}, getRuntime().name),
    },
  };
}

module.exports = function registerFixCi(register) {
  register('fix-ci', (state, ctx) => {
    if (state._isConflicting || state.failureCategory === 'conflict') {
      return buildConflictBlocked(state);
    }

    if (state.dispatched === 'fix-ci') return null; // already ran → advance to push-retry

    state.dispatched = 'fix-ci';
    const category = state.failureCategory || 'ci_failure';
    const prNum = state.prNumber || 'unknown';
    const isConflict = category === 'conflict';
    const monitorOutput = (state.lastMonitorResult?.output || '').substring(0, 1500);
    const failedJobs = Array.isArray(state._ciFailedJobs) ? state._ciFailedJobs : [];

    // `stripGhPrefix` / `filterLogs` are imported from `../log-utils` so the
    // infra-classifier can reuse the same Signal 4 raw-log scanning logic.
    const ciLogs = isConflict ? '' : fetchCiLogs(prNum, ctx, failedJobs);

    return buildExecuteInstruction(state, prNum, isConflict, monitorOutput, ciLogs);
  });
};
