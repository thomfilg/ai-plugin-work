/**
 * Step: fix-reviews — Process PR review comments one at a time.
 *
 * IMPORTANT: Only runs when Cursor Bugbot has FINISHED reviewing.
 * Triage skips this step when bot reviews are still pending
 * (Bugbot auto-dismisses old comments on re-review, so waiting avoids
 * processing stale comments).
 *
 * Flow:
 *   1. Snapshot comments (first call)
 *   2. Get next unsolved comment
 *   3. Return instruction showing exactly ONE comment
 *   4. Agent addresses it using --solve-comment or --skip-comment
 *   5. Re-enter → get next → repeat until done
 *   6. If any skipped → block for user review
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

module.exports = function registerFixReviews(register) {
  register('fix-reviews', (state, ctx) => {
    const commentsScript = path.join(ctx.workScriptsDir, 'follow-up-pr-comments.js');
    const prNum = String(state.prNumber || '');
    const scriptEnv = { ...process.env, WORK_TICKET_ID: state.ticketId };

    // First call: take snapshot
    if (!state._reviewSnapshotDone) {
      try {
        execFileSync(process.execPath, [commentsScript, '--snapshot', '--pr', prNum], {
          encoding: 'utf8',
          timeout: 30000,
          cwd: ctx.worktreeDir,
          env: scriptEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        const msg = err.stderr || err.stdout || err.message || 'unknown error';
        return {
          type: 'follow_up_instruction',
          action: 'blocked',
          reason: `Snapshot failed: ${String(msg).substring(0, 500)}`,
        };
      }
      state._reviewSnapshotDone = true;
    }

    // After agent returned from previous comment — clear dispatch, get next
    if (state.dispatched === 'fix-reviews') {
      state.dispatched = null;
    }

    // Get next unsolved comment
    let comment = null;
    try {
      const result = execFileSync(
        process.execPath,
        [commentsScript, '--next-comment'],
        { encoding: 'utf8', timeout: 15000, cwd: ctx.worktreeDir, env: scriptEnv, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      comment = JSON.parse(result);
    } catch (err) {
      // Exit 0 + {"done":true} is handled above via JSON.parse
      // Any other error (exit 1, parse error) = script failure
      const exitCode = typeof err.status === 'number' ? err.status : -1;
      if (exitCode === 1) {
        // Script error — snapshot may not exist or was corrupted
        delete state._reviewSnapshotDone;
        const msg = err.stderr || err.stdout || err.message || 'unknown error';
        return {
          type: 'follow_up_instruction',
          action: 'blocked',
          reason: `--next-comment failed: ${String(msg).substring(0, 500)}`,
        };
      }
      // JSON parse error on valid exit = no comments
      delete state._reviewSnapshotDone;
      return null;
    }

    if (!comment || comment.done) {
      delete state._reviewSnapshotDone;

      // Check for skipped comments → prompt user
      let statusResult = null;
      try {
        const raw = execFileSync(
          process.execPath,
          [commentsScript, '--status'],
          { encoding: 'utf8', timeout: 10000, cwd: ctx.worktreeDir, env: scriptEnv, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        statusResult = JSON.parse(raw);
      } catch { /* ignore */ }

      if (statusResult && statusResult.skipped > 0) {
        const reviewFile = path.join(ctx.tasksDir, 'follow-up-comments.json');
        return {
          type: 'follow_up_instruction',
          action: 'blocked',
          reason: [
            `Review comments: ${statusResult.solved} fixed, ${statusResult.skipped} skipped.`,
            `Skipped comments need your review: ${reviewFile}`,
            `After reviewing, re-run follow-up-next.js to continue.`,
          ].join('\n'),
        };
      }

      return null; // all solved → advance to push-retry
    }

    state.dispatched = 'fix-reviews';

    // Get total count for "N of M" display
    let totalComments = '?';
    let currentIndex = '?';
    try {
      const raw = execFileSync(
        process.execPath,
        [commentsScript, '--status'],
        { encoding: 'utf8', timeout: 10000, cwd: ctx.worktreeDir, env: scriptEnv, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const st = JSON.parse(raw);
      totalComments = st.remaining || st.total || '?';
      currentIndex = (st.solved || 0) + (st.skipped || 0) + 1;
    } catch { /* ignore */ }

    const author = comment.author || 'unknown';
    const filePath = comment.path || 'general';
    const line = comment.line || '';
    const body = comment.body || '';
    const priority = comment.priority || 'unknown';
    const codeContext = comment.codeContext || '';
    const commentId = comment.id;
    const fileRef = line ? `${filePath}:${line}` : filePath;

    // Build the solve/skip commands the agent must use
    const solveCmd = `node "${commentsScript}" --solve-comment "${commentId}" "<COMMIT_SHA>" "<description of what you fixed>"`;
    const skipCmd = `node "${commentsScript}" --skip-comment "${commentId}" "<reason>"`;
    const nextCmd = `node "${path.join(__dirname, '..', '..', 'follow-up-next.js')}" "${state.ticketId}"${state.prNumber ? ` --pr ${state.prNumber}` : ''}`;

    return {
      type: 'follow_up_instruction',
      action: 'execute',
      state: { ticket: state.ticketId, currentStep: 'fix-reviews', attempt: state.attempt },
      continue: true,
      delegate: {
        type: 'task',
        agentType: 'work-workflow:developer-nodejs-tdd',
        description: `Review comment ${currentIndex} of ${totalComments}: ${fileRef}`,
        prompt: [
          `## Review Comment ${currentIndex} of ${totalComments}`,
          '',
          `**Author:** ${author} | **Priority:** ${priority} | **File:** ${fileRef}`,
          '',
          body,
          '',
          codeContext ? `### Current code:\n\`\`\`\n${codeContext}\n\`\`\`\n` : '',
          '---',
          '',
          '## You MUST do exactly ONE of these:',
          '',
          '### Option A — Fix the code:',
          '1. Fix the issue in the specified file',
          '2. Stage and commit: `git add <files> && git commit -m "fix(review): <what you fixed>"`',
          '3. Then mark as addressed:',
          '```',
          solveCmd,
          '```',
          '',
          '### Option B — Skip with reason:',
          '```',
          skipCmd,
          '```',
          'Valid reasons: "Outside scope of brief/spec", "Conflicts with ticket requirements", "Conflicts with user instruction"',
          '',
          '---',
          '',
          `When done, call: \`${nextCmd}\``,
        ].join('\n'),
        note: 'Pass the prompt directly to the agent.',
      },
    };
  });
};
