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
const { execSync, spawnSync } = require('child_process');
const state = require('../state');

const BOT_RE = /(cursor|copilot|bugbot|codex|sourcery)/i;

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    return '';
  }
}

function gitOut(worktree, args) {
  const res = spawnSync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return res.status === 0 ? (res.stdout || '').trim() : '';
}

function headSha(worktree) {
  return gitOut(worktree, ['rev-parse', 'HEAD']);
}

function deriveRepo(worktree) {
  const url = gitOut(worktree || '.', ['remote', 'get-url', 'origin']);
  if (!url) return '';
  // Match owner/repo from https://github.com/owner/repo(.git) or git@github.com:owner/repo(.git)
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : '';
}

function repoSlug(worktree) {
  return process.env.GITHUB_REPO || deriveRepo(worktree);
}

function prNumberFor(ticket, worktree) {
  const repo = repoSlug(worktree);
  if (!repo) return null;
  // Branch convention from maestro-bootstrap: <ticket>-maestro
  const json = sh(
    `gh pr list --repo ${repo} --head ${ticket}-maestro --state open --json number --limit 1`
  );
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    return arr[0] && arr[0].number;
  } catch {
    return null;
  }
}

function fetchBotComments(prNumber, worktree) {
  const repo = repoSlug(worktree);
  if (!repo) return [];
  const json = sh(`gh api repos/${repo}/pulls/${prNumber}/comments --paginate 2>/dev/null`);
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

  // No comments → clear any stale marker and bail.
  if (count === 0) {
    if (prev) state.clear(ticket, 'pr-comments');
    return { hit: false };
  }

  // First time we see comments — record and bail. Wait for a stable read.
  if (!prev) {
    state.write(ticket, 'pr-comments', { count, sha, firstSeenAt: now, alerted: false });
    return { hit: false };
  }

  // HEAD moved since last check → agent has pushed; reset the watch.
  if (prev.sha !== sha) {
    state.write(ticket, 'pr-comments', { count, sha, firstSeenAt: now, alerted: false });
    return { hit: false };
  }

  // Same sha, comments still present → agent sat on them.
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
