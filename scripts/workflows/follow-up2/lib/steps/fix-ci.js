/**
 * Step: fix-ci — Fix CI failures or merge conflicts.
 *
 * Fetches the actual failed CI logs via `gh run view --log-failed`
 * and passes them to the developer agent so it knows EXACTLY what broke.
 */

'use strict';

const { execFileSync } = require('child_process');

module.exports = function registerFixCi(register) {
  register('fix-ci', (state, ctx) => {
    if (state.dispatched === 'fix-ci') return null; // already ran → advance to push-retry

    state.dispatched = 'fix-ci';
    const category = state.failureCategory || 'ci_failure';
    const prNum = state.prNumber || 'unknown';
    const monitorOutput = (state.lastMonitorResult?.output || '').substring(0, 1500);
    const isConflict = category === 'conflict';

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

    function filterLogs(rawLogs) {
      const filtered = rawLogs
        .split('\n')
        .filter((line) => {
          // Skip runner setup noise
          if (/UNKNOWN STEP|##\[group\]|##\[endgroup\]|Runner Image|Operating System/i.test(line))
            return false;
          if (
            /runner version|Secret source|Prepare workflow|Download action|Getting action/i.test(
              line
            )
          )
            return false;
          if (/Image:|Version:|Commit:|Build Date:|Worker ID:|Azure Region:/i.test(line))
            return false;
          if (/Permissions|Actions: read|Contents: read|Metadata: read|PullRequests:/i.test(line))
            return false;
          // Keep error markers, assertions, test names, meaningful output
          if (/error|fail|assert|expect|timeout|ERR_|✗|✕|FAIL|Error:|×/i.test(line)) return true;
          if (/\.(spec|test)\.(ts|js|tsx|jsx)/.test(line)) return true;
          if (/^\s+at\s/.test(line)) return true;
          if (/exit code|exit\s+\d|SIGTERM|SIGKILL|Process completed/i.test(line)) return true;
          if (/Run tests|Run e2e|playwright/i.test(line)) return true;
          return false;
        })
        .join('\n')
        .substring(0, 6000);
      if (filtered.trim()) return filtered;
      // Fallback: tail of raw logs when filter removed everything
      const lines = rawLogs.split('\n');
      return lines
        .slice(Math.max(0, lines.length - 120))
        .join('\n')
        .substring(0, 6000);
    }

    function shellSafe(s) {
      return String(s || '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function ghErr(stage, err) {
      const msg = shellSafe(err?.stderr || err?.stdout || err?.message || 'unknown');
      ciFetchErrors.push(`[${stage}] ${msg.substring(0, 300)}`);
    }

    function fetchRunLogs(runId, jobName) {
      const args = ['run', 'view', String(runId), '--log-failed'];
      if (jobName) args.push('--job', jobName);
      try {
        return execFileSync('gh', args, {
          encoding: 'utf8',
          timeout: 30000,
          cwd: ctx.worktreeDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (err) {
        ghErr(`run-view ${runId}${jobName ? ' --job=' + jobName : ''}`, err);
        return '';
      }
    }

    // Extract the failed job name from monitor output if present
    // e.g. "✗ 🧪 Integration Tests · shard 4/5 — failed"
    function extractFailedJobName(monitorText) {
      const m = String(monitorText || '').match(/[✗✕×]\s+(.+?)\s+—\s+failed/);
      return m ? m[1].trim() : null;
    }

    if (!isConflict) {
      const failedJobName = extractFailedJobName(monitorOutput);
      const candidateRunIds = new Set();

      // Strategy 1: gh pr checks
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
            '.[] | select(.state == "FAILURE") | .link',
          ],
          {
            encoding: 'utf8',
            timeout: 15000,
            cwd: ctx.worktreeDir,
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );
        for (const m of linksOutput.matchAll(/runs\/(\d+)/g)) candidateRunIds.add(m[1]);
      } catch (err) {
        ghErr('pr-checks', err);
      }

      // Strategy 2: most recent failed run on the PR branch
      if (candidateRunIds.size === 0) {
        try {
          const branchOut = execFileSync(
            'gh',
            ['pr', 'view', String(prNum), '--json', 'headRefName', '--jq', '.headRefName'],
            {
              encoding: 'utf8',
              timeout: 10000,
              cwd: ctx.worktreeDir,
              stdio: ['pipe', 'pipe', 'pipe'],
            }
          ).trim();
          if (branchOut) {
            const runListOut = execFileSync(
              'gh',
              [
                'run',
                'list',
                '--branch',
                branchOut,
                '--status',
                'failure',
                '--limit',
                '3',
                '--json',
                'databaseId',
                '--jq',
                '.[].databaseId',
              ],
              {
                encoding: 'utf8',
                timeout: 15000,
                cwd: ctx.worktreeDir,
                stdio: ['pipe', 'pipe', 'pipe'],
              }
            );
            for (const id of runListOut.split('\n').filter(Boolean)) candidateRunIds.add(id);
          }
        } catch (err) {
          ghErr('run-list-fallback', err);
        }
      }

      // Fetch + concat raw logs from up to 3 candidate runs
      const rawChunks = [];
      for (const runId of Array.from(candidateRunIds).slice(0, 3)) {
        const raw = fetchRunLogs(runId, failedJobName);
        if (raw) rawChunks.push(raw);
        if (rawChunks.join('\n').length > 12000) break;
      }

      if (rawChunks.length > 0) {
        ciLogs = filterLogs(rawChunks.join('\n'));
      } else {
        const errLines = ciFetchErrors.length
          ? ciFetchErrors.map((e) => `  - ${e}`).join('\n')
          : '  - no candidate failed runs found';
        ciLogs =
          '(Could not fetch CI logs automatically)\nCommands attempted:\n' +
          errLines +
          (failedJobName ? `\nFailing job (from monitor): ${failedJobName}` : '');
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
              '### Monitor output:',
              '```',
              monitorOutput,
              '```',
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
