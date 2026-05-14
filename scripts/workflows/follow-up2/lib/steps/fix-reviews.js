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
    // ── PRIORITY 0 guard: never process reviews against a conflicted branch.
    // Conflict was either detected on the current monitor cycle (state
    // ._isConflicting set by monitor.js) or persisted from a prior cycle.
    // Sending the agent to fix reviews against a branch that won't merge
    // wastes a round-trip and risks the "blocked: review skipped, ask
    // user" instruction when the real issue is "rebase first". Re-route
    // to fix-ci so the agent resolves the conflict before any review work.
    if (state._isConflicting) {
      state.failureCategory = 'conflict';
      state.currentStep = 'fix-ci';
      return null;
    }

    const commentsScript = path.join(ctx.workScriptsDir, 'follow-up-pr-comments.js');
    const prNum = String(state.prNumber || '');
    const scriptEnv = { ...process.env, WORK_TICKET_ID: state.ticketId };

    // First call: always take fresh snapshot to catch new comments.
    // The --snapshot command preserves solved/skipped state from previous
    // runs via previousStatusMap (GH-358), so no data is lost.
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
      const result = execFileSync(process.execPath, [commentsScript, '--next-comment'], {
        encoding: 'utf8',
        timeout: 15000,
        cwd: ctx.worktreeDir,
        env: scriptEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
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
        const raw = execFileSync(process.execPath, [commentsScript, '--status'], {
          encoding: 'utf8',
          timeout: 10000,
          cwd: ctx.worktreeDir,
          env: scriptEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        statusResult = JSON.parse(raw);
      } catch {
        /* ignore */
      }

      // When all remaining comments are terminal (solved or skipped),
      // advance directly to `report` and let the workflow finish. The
      // rationale for each skipped comment is preserved in
      // follow-up-comments.json for later review. Previously this returned
      // `action: 'blocked'` which forced a manual "I have reviewed, re-run"
      // ack-loop every time — even when the user had already approved the
      // skips. The reason for each skip is the agent's responsibility to
      // make defensible (per `feedback_review_comments_judgment`).
      //
      // Loop-break invariant: routing to `report` marks the workflow
      // `status: complete`, so re-running /follow-up2 without --init
      // returns "Already complete" instead of cycling back here.
      if (statusResult && statusResult.skipped > 0) {
        state._skippedReviewsCount = statusResult.skipped;
        state._solvedReviewsCount = statusResult.solved || 0;
        state.currentStep = 'report';
        return null;
      }

      return null; // all solved → advance to push-retry
    }

    state.dispatched = 'fix-reviews';

    // Get total count for "N of M" display
    let totalComments = '?';
    let currentIndex = '?';
    try {
      const raw = execFileSync(process.execPath, [commentsScript, '--status'], {
        encoding: 'utf8',
        timeout: 10000,
        cwd: ctx.worktreeDir,
        env: scriptEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const st = JSON.parse(raw);
      totalComments = st.remaining || st.total || '?';
      currentIndex = (st.solved || 0) + (st.skipped || 0) + 1;
    } catch {
      /* ignore */
    }

    const author = comment.author || 'unknown';
    const filePath = comment.path || 'general';
    const line = comment.line || '';
    const rawBody = comment.body || '';
    const priority = comment.priority || 'unknown';

    // Strip noise from Cursor Bugbot comments: HTML links, base64 URLs, metadata
    const body = rawBody
      .replace(/<div>[\s\S]*?<\/div>/g, '') // cursor fix-in-cursor/fix-in-web buttons
      .replace(/<details>[\s\S]*?<\/details>/g, '') // collapsed additional locations
      .replace(/<sup>[\s\S]*?<\/sup>/g, '') // "Reviewed by Cursor Bugbot" footer
      .replace(/<!--[\s\S]*?-->/g, '') // HTML comments (BUGBOT_BUG_ID, LOCATIONS, DESCRIPTION markers)
      .replace(/<\/?picture>|<source[^>]*>|<img[^>]*>/g, '') // image tags
      .replace(/<a[^>]*>[\s\S]*?<\/a>/g, '') // remaining anchor tags
      .replace(/\n{3,}/g, '\n\n') // collapse excessive blank lines
      .trim();
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
