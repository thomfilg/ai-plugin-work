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
 *   4. Agent addresses it using --mark-locally-solved or --mark-locally-skipped
 *   5. Re-enter → get next → repeat until done
 *   6. If any skipped → block for user review
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

function blocked(reason) {
  return { type: 'follow_up_instruction', action: 'blocked', reason };
}

// Single chokepoint for invoking follow-up-pr-comments.js. `timeout` varies by
// subcommand; everything else (cwd, env, pipe stdio) is shared.
function runComments(commentsScript, args, ctx, scriptEnv, timeout) {
  return execFileSync(process.execPath, [commentsScript, ...args], {
    encoding: 'utf8',
    timeout,
    cwd: ctx.worktreeDir,
    env: scriptEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// Parse `--status` JSON ({ remaining, total, solved, skipped }). Returns null
// on any error. Shared by the done-path skip check and the "N of M" counter.
function readCommentsStatus(commentsScript, ctx, scriptEnv) {
  try {
    return JSON.parse(runComments(commentsScript, ['--status'], ctx, scriptEnv, 10000));
  } catch {
    return null;
  }
}

// First call: always take a fresh snapshot to catch new comments. The
// --snapshot command preserves solved/skipped state from previous runs via
// previousStatusMap (GH-358), so no data is lost. Returns a blocked
// instruction on failure, else null (snapshot recorded on state).
function ensureSnapshot(state, commentsScript, prNum, ctx, scriptEnv) {
  if (state._reviewSnapshotDone) return null;
  try {
    runComments(commentsScript, ['--snapshot', '--pr', prNum], ctx, scriptEnv, 30000);
  } catch (err) {
    const msg = err.stderr || err.stdout || err.message || 'unknown error';
    return blocked(`Snapshot failed: ${String(msg).substring(0, 500)}`);
  }
  state._reviewSnapshotDone = true;
  return null;
}

// Get the next unsolved comment. Returns one of:
//   { blocked }      — script error (exit 1)
//   { advance: true } — parse error on a valid exit = no comments → return null
//   { comment }      — parsed comment (may be null or have .done)
function fetchNextComment(state, commentsScript, ctx, scriptEnv) {
  try {
    const result = runComments(commentsScript, ['--next-comment'], ctx, scriptEnv, 15000);
    return { comment: JSON.parse(result) };
  } catch (err) {
    // Exit 0 + {"done":true} is handled by the caller via the parsed object.
    // Any other error (exit 1, parse error) = script failure.
    const exitCode = typeof err.status === 'number' ? err.status : -1;
    if (exitCode === 1) {
      // Script error — snapshot may not exist or was corrupted
      delete state._reviewSnapshotDone;
      const msg = err.stderr || err.stdout || err.message || 'unknown error';
      return { blocked: blocked(`--next-comment failed: ${String(msg).substring(0, 500)}`) };
    }
    // JSON parse error on valid exit = no comments
    delete state._reviewSnapshotDone;
    return { advance: true };
  }
}

// No more actionable comments. When all remaining comments are terminal (solved
// or skipped), advance directly to `report` and let the workflow finish — the
// rationale for each skip is preserved in follow-up-comments.json for later
// review. Previously this returned `action: 'blocked'` which forced a manual
// "I have reviewed, re-run" ack-loop even after the user had approved the skips.
//
// Loop-break invariant: routing to `report` marks the workflow `status:
// complete`, so re-running /follow-up without --init returns "Already complete"
// instead of cycling back here. Always returns null (advance / loop).
function handleNoMoreComments(state, commentsScript, ctx, scriptEnv) {
  delete state._reviewSnapshotDone;
  const statusResult = readCommentsStatus(commentsScript, ctx, scriptEnv);
  if (statusResult && statusResult.skipped > 0) {
    state._skippedReviewsCount = statusResult.skipped;
    state._solvedReviewsCount = statusResult.solved || 0;
    state.currentStep = 'report';
  }
  return null;
}

function computeCounts(st) {
  if (!st) return { totalComments: '?', currentIndex: '?' };
  return {
    totalComments: st.remaining || st.total || '?',
    currentIndex: (st.solved || 0) + (st.skipped || 0) + 1,
  };
}

// Strip noise from Cursor Bugbot comments: HTML links, base64 URLs, metadata.
function cleanCommentBody(rawBody) {
  return rawBody
    .replace(/<div>[\s\S]*?<\/div>/g, '') // cursor fix-in-cursor/fix-in-web buttons
    .replace(/<details>[\s\S]*?<\/details>/g, '') // collapsed additional locations
    .replace(/<sup>[\s\S]*?<\/sup>/g, '') // "Reviewed by Cursor Bugbot" footer
    .replace(/<!--[\s\S]*?-->/g, '') // HTML comments (BUGBOT_BUG_ID, LOCATIONS, DESCRIPTION markers)
    .replace(/<\/?picture>|<source[^>]*>|<img[^>]*>/g, '') // image tags
    .replace(/<a[^>]*>[\s\S]*?<\/a>/g, '') // remaining anchor tags
    .replace(/\n{3,}/g, '\n\n') // collapse excessive blank lines
    .trim();
}

function buildReviewPrompt(comment, fileRef, counts, commands) {
  const author = comment.author || 'unknown';
  const priority = comment.priority || 'unknown';
  const body = cleanCommentBody(comment.body || '');
  const codeContext = comment.codeContext || '';
  return [
    `## Review Comment ${counts.currentIndex} of ${counts.totalComments}`,
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
    commands.solveCmd,
    '```',
    '',
    '### Option B — Skip with reason:',
    '```',
    commands.skipCmd,
    '```',
    'Valid reasons: "Outside scope of brief/spec", "Conflicts with ticket requirements", "Conflicts with user instruction"',
    '',
    '---',
    '',
    `When done, call: \`${commands.nextCmd}\``,
    '',
    '**Do NOT pipe the output** (no `| head`, `| tail`, `| grep`, `> file`, `2>&1 |`). Piping truncates the JSON delegate block and hides next-step instructions. Run the command raw.',
  ].join('\n');
}

function buildReviewExecute(state, comment, commentsScript, counts) {
  const filePath = comment.path || 'general';
  const line = comment.line || '';
  const fileRef = line ? `${filePath}:${line}` : filePath;
  const commentId = comment.id;

  // Build the solve/skip commands the agent must use. The new flag names
  // (GH-537) make the local-only scope explicit; the legacy aliases still work
  // but emit a deprecation warning. The opt-in GitHub-resolve flag is
  // intentionally NOT surfaced to the agent here — it stays reachable only for
  // humans invoking the CLI directly.
  const commands = {
    solveCmd: `node "${commentsScript}" --mark-locally-solved "${commentId}" "<COMMIT_SHA>" "<description of what you fixed>"`,
    skipCmd: `node "${commentsScript}" --mark-locally-skipped "${commentId}" "<reason>"`,
    nextCmd: `node "${path.join(__dirname, '..', '..', 'follow-up-next.js')}" "${state.ticketId}"${state.prNumber ? ` --pr ${state.prNumber}` : ''}`,
  };

  return {
    type: 'follow_up_instruction',
    action: 'execute',
    state: { ticket: state.ticketId, currentStep: 'fix-reviews', attempt: state.attempt },
    continue: true,
    delegate: {
      type: 'task',
      agentType: 'work-workflow:developer-nodejs-tdd',
      description: `Review comment ${counts.currentIndex} of ${counts.totalComments}: ${fileRef}`,
      prompt: buildReviewPrompt(comment, fileRef, counts, commands),
      note: 'Pass the prompt directly to the agent.',
    },
  };
}

module.exports = function registerFixReviews(register) {
  register('fix-reviews', (state, ctx) => {
    // ── PRIORITY 0 guard: never process reviews against a conflicted branch.
    // Conflict was either detected on the current monitor cycle (state
    // ._isConflicting set by monitor.js) or persisted from a prior cycle.
    // Sending the agent to fix reviews against a branch that won't merge
    // wastes a round-trip and risks the "blocked: review skipped, ask user"
    // instruction when the real issue is "rebase first". Re-route to fix-ci so
    // the agent resolves the conflict before any review work.
    if (state._isConflicting) {
      state.failureCategory = 'conflict';
      state.currentStep = 'fix-ci';
      return null;
    }

    const commentsScript = path.join(ctx.workScriptsDir, 'follow-up-pr-comments.js');
    const prNum = String(state.prNumber || '');
    const scriptEnv = { ...process.env, WORK_TICKET_ID: state.ticketId };

    const snapshotBlocked = ensureSnapshot(state, commentsScript, prNum, ctx, scriptEnv);
    if (snapshotBlocked) return snapshotBlocked;

    // After agent returned from previous comment — clear dispatch, get next
    if (state.dispatched === 'fix-reviews') state.dispatched = null;

    const next = fetchNextComment(state, commentsScript, ctx, scriptEnv);
    if (next.blocked) return next.blocked;
    if (next.advance) return null;
    const comment = next.comment;

    if (!comment || comment.done) {
      return handleNoMoreComments(state, commentsScript, ctx, scriptEnv);
    }

    state.dispatched = 'fix-reviews';
    const counts = computeCounts(readCommentsStatus(commentsScript, ctx, scriptEnv));
    return buildReviewExecute(state, comment, commentsScript, counts);
  });
};
