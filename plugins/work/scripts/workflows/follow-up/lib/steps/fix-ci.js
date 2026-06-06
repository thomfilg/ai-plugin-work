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

module.exports = function registerFixCi(register) {
  register('fix-ci', (state, ctx) => {
    // ── HARD STOP on merge conflict ─────────────────────────────────────
    // Conflicts are NOT auto-resolved. Halt the workflow and tell the
    // agent (and the user) to sync the branch before continuing. This
    // prevents auto-rebase delegates from silently dropping upstream
    // changes that need human judgement (big sibling-PR merges, conflicting
    // schema migrations, etc).
    if (state._isConflicting || state.failureCategory === 'conflict') {
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
        reason: `Merge conflicts found on PR #${prNum}${baseSuffix} — sync your branch with the target branch before proceeding.${fileSuffix} Then re-run /follow-up ${state.ticketId || ''}.`,
        state: { ticket: state.ticketId, currentStep: 'fix-ci', attempt: state.attempt || 0 },
      };
    }

    if (state.dispatched === 'fix-ci') return null; // already ran → advance to push-retry

    state.dispatched = 'fix-ci';
    const category = state.failureCategory || 'ci_failure';
    const prNum = state.prNumber || 'unknown';
    const monitorOutput = (state.lastMonitorResult?.output || '').substring(0, 1500);
    const isConflict = category === 'conflict';
    const ciStatusLine = state._ciStatusLine || '';
    const ciStatusDetail = state._ciStatusDetail || '';
    const failedJobs = Array.isArray(state._ciFailedJobs) ? state._ciFailedJobs : [];

    // For CI failures: fetch the actual failed run logs.
    // Strategy:
    //   1. Try `gh pr checks --json` to get FAILURE links.
    //   2. Fall back to `gh run list --branch <branch>` for the latest failed run.
    //   3. For each candidate run, fetch `--log-failed` (with optional --job filter
    //      using the failing job name extracted from monitor output).
    //   4. Filter to test/assert lines only; truncate to fit prompt budget.
    //   5. Surface real fetch errors instead of swallowing them.
    let ciLogs = '';
    const ciFetchErrors = [];

    // `stripGhPrefix` / `filterLogs` are imported from `../log-utils` so the
    // infra-classifier can reuse the same Signal 4 raw-log scanning logic.

    function shellSafe(s) {
      return String(s || '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function ghErr(stage, err) {
      const msg = shellSafe(err?.stderr || err?.stdout || err?.message || 'unknown');
      ciFetchErrors.push(`[${stage}] ${msg.substring(0, 300)}`);
    }

    // NOTE: gh's `--job` flag requires a numeric job ID (not a name). We don't
    // have job IDs here — only check-run names — so we run `--log-failed` for
    // the entire run. That already filters to failing steps; our filterLogs()
    // strips the rest of the noise.
    function fetchRunLogs(runId) {
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
        ghErr(`run-view ${runId}`, err);
        return '';
      }
    }

    if (!isConflict) {
      // Strategy 1 (preferred): use the structured failed-job list captured
      // by monitor.js — exact job names + runIds derived from the check `link`.
      const targets = [];
      for (const j of failedJobs) {
        if (j && j.name && j.runId) targets.push({ name: j.name, runId: j.runId });
      }

      // Strategy 2 (fallback): re-query gh pr checks for failed jobs+links
      if (targets.length === 0) {
        try {
          const linksOutput = execFileSync(
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
          for (const line of linksOutput.split('\n').filter(Boolean)) {
            const [name, link] = line.split('\t');
            const m = String(link || '').match(/runs\/(\d+)/);
            if (name && m) targets.push({ name: name.trim(), runId: m[1] });
          }
        } catch (err) {
          ghErr('pr-checks', err);
        }
      }

      // Fetch logs only for the actually-failed jobs (up to 3 distinct runIds)
      const seenRuns = new Set();
      const chunks = [];
      for (const t of targets) {
        if (seenRuns.has(t.runId)) continue;
        seenRuns.add(t.runId);
        const raw = fetchRunLogs(t.runId);
        if (raw) chunks.push(`### Failed job: ${t.name}\n` + filterLogs(raw));
        if (chunks.join('\n').length > 8000) break;
        if (seenRuns.size >= 3) break;
      }

      if (chunks.length > 0) {
        ciLogs = chunks.join('\n\n').substring(0, 8000);
      } else {
        const errLines = ciFetchErrors.length
          ? ciFetchErrors.map((e) => `  - ${e}`).join('\n')
          : '  - no failed jobs reported by monitor or gh pr checks';
        const jobsHint = targets.length
          ? '\nFailed jobs (from monitor): ' + targets.map((t) => t.name).join(', ')
          : '';
        ciLogs =
          '(Could not fetch CI logs automatically)\nCommands attempted:\n' + errLines + jobsHint;
      }
    }

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
          ? [
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
            ].join('\n')
          : [
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
            ].join('\n'),
        note: 'Pass the prompt directly to the agent.',
      },
    };
  });
};
