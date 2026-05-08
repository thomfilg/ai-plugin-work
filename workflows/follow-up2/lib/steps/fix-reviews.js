/**
 * Step: fix-reviews — Process PR review comments one at a time.
 *
 * Runs follow-up-pr-comments.js inline:
 *   1. --snapshot (first call only)
 *   2. --next-comment → get exact comment
 *   3. Dispatch developer to fix or skip
 *   4. Developer commits fix OR script records skip via --skip-comment
 *   5. Repeat until all comments processed
 *
 * When only skipped comments remain → prompts user to review follow-up-comments.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = function registerFixReviews(register) {
  register('fix-reviews', (state, ctx) => {
    const commentsScript = path.join(ctx.workScriptsDir, 'follow-up-pr-comments.js');
    const prNum = String(state.prNumber || '');

    // First call: take snapshot
    if (!state._reviewSnapshotDone) {
      try {
        execFileSync(process.execPath, [commentsScript, '--snapshot', '--pr', prNum], {
          encoding: 'utf8',
          timeout: 30000,
          cwd: ctx.worktreeDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        return null; // snapshot failed — skip reviews
      }
      state._reviewSnapshotDone = true;
    }

    // After developer returned — record result then get next
    if (state.dispatched === 'fix-reviews' && state._pendingCommentId) {
      // Check if developer made changes (committed)
      let lastCommitSha = '';
      try {
        lastCommitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
          encoding: 'utf8',
          timeout: 5000,
          cwd: ctx.worktreeDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } catch {
        /* ignore */
      }

      // Check if there are uncommitted changes (developer fixed but didn't commit)
      let hasUncommitted = false;
      try {
        const porcelain = execFileSync('git', ['status', '--porcelain'], {
          encoding: 'utf8',
          timeout: 5000,
          cwd: ctx.worktreeDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        hasUncommitted = porcelain.length > 0;
      } catch {
        /* ignore */
      }

      const priorSha = state._priorHeadSha || '';
      const wasCommitted = lastCommitSha && lastCommitSha !== priorSha;

      if (wasCommitted) {
        // Developer committed a fix → mark solved
        try {
          execFileSync(
            process.execPath,
            [
              commentsScript,
              '--solve-comment',
              state._pendingCommentId,
              lastCommitSha,
              'Fixed by developer',
            ],
            {
              encoding: 'utf8',
              timeout: 10000,
              cwd: ctx.worktreeDir,
              stdio: ['pipe', 'pipe', 'pipe'],
            }
          );
        } catch {
          /* fail-open */
        }
      } else if (!hasUncommitted) {
        // No changes at all → developer decided to skip
        // Read skip reason from follow-up-skips.md if it exists
        let skipReason = 'Developer determined no code change needed';
        const skipsFile = path.join(ctx.tasksDir, 'follow-up-skips.md');
        try {
          const content = fs.readFileSync(skipsFile, 'utf8');
          const lines = content.trim().split('\n');
          const lastLine = lines[lines.length - 1];
          const reasonMatch = lastLine.match(/SKIPPED\s*—\s*(.+)$/);
          if (reasonMatch) skipReason = reasonMatch[1].trim();
        } catch {
          /* no skips file */
        }

        try {
          execFileSync(
            process.execPath,
            [commentsScript, '--skip-comment', state._pendingCommentId, skipReason],
            {
              encoding: 'utf8',
              timeout: 10000,
              cwd: ctx.worktreeDir,
              stdio: ['pipe', 'pipe', 'pipe'],
            }
          );
        } catch {
          /* fail-open */
        }
      }
      // If hasUncommitted but not committed — developer partially fixed. Leave as unsolved for next round.

      delete state._pendingCommentId;
      delete state._priorHeadSha;
      state.dispatched = null;
    }

    // Get next unresolved comment
    let comment = null;
    try {
      const result = execFileSync(process.execPath, [commentsScript, '--next-comment'], {
        encoding: 'utf8',
        timeout: 15000,
        cwd: ctx.worktreeDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      comment = JSON.parse(result);
    } catch {
      delete state._reviewSnapshotDone;
      return null; // no more comments → advance
    }

    if (!comment || comment.done) {
      delete state._reviewSnapshotDone;

      // Check if there are skipped comments → prompt user
      let statusResult = null;
      try {
        const raw = execFileSync(process.execPath, [commentsScript, '--status'], {
          encoding: 'utf8',
          timeout: 10000,
          cwd: ctx.worktreeDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        statusResult = JSON.parse(raw);
      } catch {
        /* ignore */
      }

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

    // Save HEAD sha before developer works
    let headSha = '';
    try {
      headSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        timeout: 5000,
        cwd: ctx.worktreeDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      /* ignore */
    }

    state.dispatched = 'fix-reviews';
    state._pendingCommentId = comment.id;
    state._priorHeadSha = headSha;

    const author = comment.author || 'unknown';
    const filePath = comment.path || 'unknown file';
    const line = comment.line || 'N/A';
    const body = comment.body || '';
    const priority = comment.priority || 'unknown';
    const codeContext = comment.codeContext || '';
    const skipsFile = path.join(ctx.tasksDir, 'follow-up-skips.md');

    return {
      type: 'follow_up_instruction',
      action: 'execute',
      state: { ticket: state.ticketId, currentStep: 'fix-reviews', attempt: state.attempt },
      continue: true,
      delegate: {
        type: 'task',
        agentType: 'work-workflow:developer-nodejs-tdd',
        description: `Fix review: ${filePath}:${line} by ${author}`,
        prompt: [
          `## PR #${prNum} Review Comment`,
          '',
          `| Field | Value |`,
          `|-------|-------|`,
          `| Author | ${author} |`,
          `| Priority | ${priority} |`,
          `| File | ${filePath} |`,
          `| Line | ${line} |`,
          '',
          '### Comment:',
          body,
          '',
          codeContext
            ? `### Current code at ${filePath}:${line}:\n\`\`\`\n${codeContext}\n\`\`\`\n`
            : '',
          '### You MUST do exactly ONE of these:',
          '',
          '**Option A — Fix and commit:**',
          '1. Fix the code in the specified file',
          '2. Stage the changed files',
          '3. Commit with message: `fix(review): <what you fixed>`',
          '4. Do NOT push',
          '',
          '**Option B — Skip with reason:**',
          `Append to \`${skipsFile}\`:`,
          '```',
          `- **${filePath}:${line}** (${author}): SKIPPED — <reason>`,
          '```',
          '',
          'Valid skip reasons ONLY:',
          '- "Outside scope of brief/spec" — the suggestion goes beyond what the ticket requires',
          '- "Conflicts with ticket requirements" — contradicts ticket.json/brief.md',
          '- "Conflicts with user instruction" — goes against an explicit user decision',
          '',
          'Do NOT skip for any other reason. If the comment points to a real bug, fix it.',
        ].join('\n'),
        note: 'Pass the prompt directly to the agent.',
      },
    };
  });
};
