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

    // For CI failures: fetch the actual failed run logs
    let ciLogs = '';
    if (!isConflict) {
      try {
        // Get failed run ID from PR checks
        const runsJson = execFileSync(
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
        ).trim();

        // Extract run ID from URL (e.g., .../runs/12345/...)
        const runMatch = runsJson.match(/runs\/(\d+)/);
        if (runMatch) {
          ciLogs = execFileSync('gh', ['run', 'view', runMatch[1], '--log-failed'], {
            encoding: 'utf8',
            timeout: 30000,
            cwd: ctx.worktreeDir,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).substring(0, 3000);
        }
      } catch {
        ciLogs = '(Could not fetch CI logs automatically)';
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
