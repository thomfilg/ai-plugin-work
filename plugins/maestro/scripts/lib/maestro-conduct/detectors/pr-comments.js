/**
 * detectors/pr-comments.js
 *
 * Detect unaddressed bot review comments (Cursor Bugbot, Copilot, Codex…)
 * on the open PR for a ticket.
 *
 * Signal: number of comments at a CURRENT diff position (position !== null)
 * authored by a bot. Outdated comments (position === null) are ignored — the
 * agent has already pushed past them.
 *
 * Stateful: a hit only "fires" when the comment count is stable across two
 * consecutive checks AND the worktree HEAD sha hasn't changed since we last
 * looked. That way fresh commits naturally reset the clock and we don't
 * nudge while the agent is mid-fix.
 *
 * The PR number is resolved from the branch name `<ticket>-maestro` via
 * `gh pr list --head`. Result is cached per tick.
 */
const state = require('../state');
const { spawnOut, headSha, repoSlug, prNumberFor } = require('./gh-shared');

const BOT_RE = /(cursor|copilot|bugbot|codex|sourcery)/i;

function fetchBotComments(prNumber, worktree) {
  const repo = repoSlug(worktree);
  if (!repo) return [];
  const json = spawnOut('gh', ['api', `repos/${repo}/pulls/${prNumber}/comments`, '--paginate']);
  if (!json) return [];
  let arr;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  return arr.filter((c) => {
    const login = (c.user && c.user.login) || '';
    return BOT_RE.test(login) && c.position !== null;
  });
}

function summarize(comments) {
  return comments.slice(0, 5).map((c) => {
    const sev = (c.body || '').match(/\*\*([A-Z][a-z]+) Severity\*\*/);
    const title = (c.body || '').split('\n').find((l) => l.startsWith('###')) || '';
    return {
      file: c.path,
      line: c.original_line || c.line,
      severity: sev ? sev[1] : null,
      title: title.replace(/^###\s*/, '').slice(0, 80),
    };
  });
}

function detect({ ticket, worktree }) {
  if (!ticket || !worktree) return { hit: false };

  const prNumber = prNumberFor(ticket, worktree);
  if (!prNumber) return { hit: false }; // no open PR yet

  const comments = fetchBotComments(prNumber, worktree);
  const count = comments.length;
  const sha = headSha(worktree);

  const prev = state.read(ticket, 'pr-comments');
  const now = state.now();

  // No comments → clear any stale marker and bail. Signal reset so the caller
  // can also purge the persisted alert repeat count; otherwise a later stuck
  // cycle would inherit the prior count and fire freeDeadEndSlot too soon.
  if (count === 0) {
    if (prev) state.clear(ticket, 'pr-comments');
    return { hit: false, reset: !!prev };
  }

  // First time we see comments — record and bail. Wait for a stable read.
  if (!prev) {
    state.write(ticket, 'pr-comments', { count, sha, firstSeenAt: now, alerted: false });
    return { hit: false };
  }

  // HEAD moved since last check → agent has pushed; reset the watch. Also
  // reset the persisted alert repeat count so a new stuck cycle starts at 1.
  if (prev.sha !== sha) {
    state.write(ticket, 'pr-comments', { count, sha, firstSeenAt: now, alerted: false });
    return { hit: false, reset: true };
  }

  // Count changed (bot still posting, or new wave of comments) → reset the
  // full watch: nudges + alerted clear too. Otherwise an exhausted prior
  // escalation cycle would silence escalation for the new comments forever.
  // Reset the persisted alert count for the same reason.
  if (prev.count !== count) {
    state.write(ticket, 'pr-comments', { count, sha, firstSeenAt: now, alerted: false });
    return { hit: false, reset: true };
  }

  // Same sha and same count two reads in a row → agent sat on them.
  const minsStuck = state.minutesSince(prev.firstSeenAt);
  return {
    hit: true,
    kind: 'pr-comments-unaddressed',
    prNumber,
    count,
    minsStuck,
    sha,
    summary: summarize(comments),
    marker: prev,
  };
}

module.exports = { name: 'prComments', detect };
